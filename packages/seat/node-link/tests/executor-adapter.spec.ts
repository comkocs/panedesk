/** Receiving adapters cannot bypass atomic admission or widen a captured delegation. */
import { expect, test, vi } from 'vitest'
import type * as Seat from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-host-admin'
import { createNodeLinkExecutor } from '../src/executor.ts'
import { decodeRequest } from '../src/codec.ts'
import { failure } from '../src/receiver.ts'
import { NODE_LINK_VERSION } from '../src/index.ts'
import type { NodeLinkExecutionDependencies } from '../src/execution.ts'

function request() {
  const payload = { operationId: 'operation-a', seat: 'seat-a', nodeId: 'node-b' }
  const deadline = new Date(Date.now() + 60000).toISOString()
  return decodeRequest({ version: NODE_LINK_VERSION, requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: payload.operationId, deadline, hop: 1, method: 'seat.wake', payload, payloadDigest: digest(payload),
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'authorization-a',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId: payload.operationId,
      requestDigest: digest(payload), taskIds: [], expiresAt: deadline } })
}

test('refuses missing atomic admission and passes exact grants only to the local admission owner', async () => {
  const input = request()
  const grant = { fact: { authorizationId: 'local-grant' as Seat.SeatAuthorizationGrant['fact']['authorizationId'],
    kind: 'node-delegation', principalId: input.delegation.principalId,
    origin: 'remote', nodeId: input.targetNodeId, operationId: input.operationId, requestDigest: input.payloadDigest,
    delegatedBy: input.delegation.authorizationRef, taskIds: [], policyRevision: 1, decision: 'allowed',
    reasonCode: 'allowed', checkedAt: new Date().toISOString() } satisfies Seat.SeatAuthorizationGrant['fact'] } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  const check = vi.fn(async () => grant)
  const dependencies: NodeLinkExecutionDependencies = { nodeId: input.targetNodeId,
    peer: { sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId, authenticatedAt: new Date().toISOString() },
    policy: { permissions: [], expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, authorize: async () => ({ check }) },
    authorization: {} as Seat.SeatAuthorizationTransactions, localSeats: {} as Seat.SeatService }
  const missing = createNodeLinkExecutor(dependencies)
  expect(await missing.authorize(input)).toBe(true)
  expect(await missing.execute(input)).toMatchObject({ error: { code: 'cross-node-unsupported' } })
  const execute = vi.fn(async () => failure(input, 'cross-node-unsupported'))
  const executor = createNodeLinkExecutor({ ...dependencies, localAdmission: { execute } })
  await executor.execute(input)
  expect(execute).toHaveBeenCalledWith(input, grant)
  check.mockResolvedValue({ ...grant, fact: { ...grant.fact,
    principalId: 'another-principal' as Seat.SeatPrincipalId } })
  expect(await executor.authorize(input)).toBe(false)
  expect(await executor.execute(input)).toMatchObject({ error: { code: 'node-delegation-rejected' } })
  expect(execute).toHaveBeenCalledTimes(1)
})
