/** Independent retained facts, not wire claims, constrain every receiving grant. */
import { expect, test, vi } from 'vitest'
import type * as Seat from '@panedesk/dsh-seat'
import { chainAuthority } from '../src/chain-authority.ts'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import type { ChainReceivingPolicy } from '../src/chain-services.ts'
import { chainFailure } from '../src/chain-identity.ts'

test('requires exact revision read policy ownership and refuses expired revoked or mismatched authority', async () => {
  const f = fixture(), method = 'seat.definitionRevision' as const
  const payload = { seat: 'seat-a', sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'owner-a',
    openingMethod: 'seat.openFrozen', taskIds: ['task-a'] }
  const make = (body = payload) => decodeChainRequest({ ...f.request, method, payload: body,
    payloadDigest: chainDigest(method, body), delegation: { ...f.request.delegation,
      seat: body.seat, requestDigest: chainDigest(method, body) } })
  const policy: ChainReceivingPolicy = { ...f.policy, authorize: async (request, peer, evidence) => {
    if (request.method !== method) throw new Error('Expected exact revision read')
    const reason = request.payload.sourceId !== payload.sourceId
      || request.payload.sourceOwnerNodeId !== payload.sourceOwnerNodeId ? 'source-mismatch'
      : request.payload.ownerEpoch !== payload.ownerEpoch ? 'owner-epoch-mismatch'
        : request.payload.seat !== payload.seat ? 'method-not-allowed' : undefined
    if (reason) {
      const response = chainFailure(request, 'node-delegation-rejected', reason)
      if (response.status === 'ok') throw new Error('Expected refusal')
      return response.error
    }
    const grant = { ...f.grant, fact: { ...evidence.fact, kind: 'node-delegation' as const,
      nodeId: peer.targetNodeId, sourceNodeId: peer.sourceNodeId, delegatedBy: request.delegation.authorizationRef } }
    return { check: async () => grant }
  } }
  const evidenceFor = (request: ReturnType<typeof make>) => ({ ...f.retained,
    request: { ...f.retained.request, method, payloadDigest: request.payloadDigest },
    fact: { ...f.retained.fact, seat: request.delegation.seat!, requestDigest: request.payloadDigest } })
  const request = make(), retained = evidenceFor(request)
  expect(await chainAuthority(request, f.peer, policy, async () => retained)).toHaveProperty('authorization')
  for (const [patch, reasonCode] of [[{ sourceId: 'other' }, 'source-mismatch'], [{ ownerEpoch: 'other' }, 'owner-epoch-mismatch'],
    [{ seat: 'other' }, 'method-not-allowed'], [{ sourceOwnerNodeId: 'node-b' }, 'source-mismatch']] as const) {
    const changed = make({ ...payload, ...patch })
    expect(await chainAuthority(changed, f.peer, policy, async () => evidenceFor(changed))).toMatchObject({ cause: { reasonCode } })
  }
  expect(await chainAuthority({ ...request, deadline: '2000-01-01T00:00:00.000Z' }, f.peer, policy, async () => retained))
    .toMatchObject({ cause: { reasonCode: 'deadline-exceeded' } })
  const revoked = chainFailure(request, 'node-delegation-rejected', 'evidence-revoked')
  if (revoked.status === 'ok') throw new Error('Expected refusal')
  expect(await chainAuthority(request, f.peer, policy, async () => ({ status: 'rejected', cause: revoked.error.cause })))
    .toMatchObject({ cause: { reasonCode: 'evidence-revoked' } })
  expect(await chainAuthority(request, { ...f.peer, sourceNodeId: f.peer.targetNodeId }, policy, async () => retained))
    .toMatchObject({ cause: { reasonCode: 'node-mismatch' } })
  for (const patch of [{ principalId: 'other' as Seat.SeatPrincipalId }, { nodeId: f.peer.targetNodeId },
    { seat: 'other' as Seat.SeatName }, { taskIds: [] }, { authorizationId: 'other' as Seat.AuthorizationRef },
    { operationId: 'other' as Seat.SeatOperationId }, { requestDigest: 'other' as Seat.SeatDigest }]) {
    expect(await chainAuthority(request, f.peer, policy, async () => ({ ...retained, fact: { ...retained.fact, ...patch } })))
      .toMatchObject({ cause: { reasonCode: 'evidence-digest-mismatch' } })
  }
})

function fixture() {
  const now = Date.now(), expiresAt = new Date(now + 30000).toISOString()
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'],
    operationId: 'operation-a', targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const request = decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline: expiresAt, hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'], expiresAt } })
  const peer = { sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, authenticatedAt: new Date(now).toISOString() }
  const fact: Seat.SeatIssuedAuthorizationFact = { authorizationId: request.delegation.authorizationRef, kind: 'human',
    principalId: request.delegation.principalId, origin: 'manual', nodeId: request.sourceNodeId, taskIds: request.delegation.taskIds,
    operationId: request.operationId, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
    requestDigest: request.payloadDigest, checkedAt: new Date(now).toISOString() }
  const retained: Extract<Seat.NodeDelegationEvidenceResult, { status: 'retained' }> = { status: 'retained',
    request: { authorizationRef: fact.authorizationId, method: request.method, operationId: request.operationId,
      payloadDigest: request.payloadDigest, sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId },
    fact, expiresAt, revoked: false }
  // The authorization owner is a double; no journal authority is claimed by this fixture.
  const grant = { fact: { ...fact, kind: 'node-delegation', nodeId: request.targetNodeId,
    sourceNodeId: peer.sourceNodeId, delegatedBy: request.delegation.authorizationRef } } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  const authorize = vi.fn(async () => ({ check: async () => grant }))
  const policy: ChainReceivingPolicy = { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, authorize }
  const lookup = vi.fn(async () => retained)
  return { request, peer, retained, policy, authorize, lookup, grant }
}

test('requires independent exact evidence before asking policy for a local grant', async () => {
  const f = fixture()
  const context = await chainAuthority(f.request, f.peer, f.policy, f.lookup)
  expect(context).toMatchObject({ principalId: f.request.delegation.principalId, nodeId: f.request.targetNodeId })
  expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.retained.request)
  expect(f.authorize).toHaveBeenCalledExactlyOnceWith(f.request, f.peer, f.retained)
  f.authorize.mockClear()
  const changed = { ...f.retained, fact: { ...f.retained.fact, requestDigest: 'changed' as Seat.SeatDigest } }
  expect(await chainAuthority(f.request, f.peer, f.policy, async () => changed))
    .toMatchObject({ cause: { reasonCode: 'evidence-digest-mismatch' } })
  expect(f.authorize).not.toHaveBeenCalled()
})

test('rejects a local grant lacking the transport-authenticated source node or naming another node', async () => {
  const f = fixture()
  for (const sourceNodeId of [undefined, f.peer.targetNodeId]) {
    const { sourceNodeId: previous, ...fact } = f.grant.fact
    void previous
    const changed = { ...f.grant, fact: { ...fact, ...(sourceNodeId === undefined ? {} : { sourceNodeId }) } }
    f.authorize.mockImplementation(async () => ({ check: async () => changed }))
    expect(await chainAuthority(f.request, f.peer, f.policy, f.lookup)).toMatchObject({ cause: { reasonCode: 'method-not-allowed' } })
  }
})

test('rejects missing policy, mismatched peer and expired delegation without requesting evidence', async () => {
  const f = fixture()
  expect(await chainAuthority(f.request, f.peer, undefined, f.lookup)).toMatchObject({ cause: { reasonCode: 'hello-policy-not-ready' } })
  expect(await chainAuthority(f.request, { ...f.peer, sourceNodeId: f.request.targetNodeId }, f.policy, f.lookup))
    .toMatchObject({ cause: { reasonCode: 'node-mismatch' } })
  const expired = { ...f.request, delegation: { ...f.request.delegation, expiresAt: '2000-01-01T00:00:00.000Z' } }
  expect(await chainAuthority(expired, f.peer, f.policy, f.lookup)).toMatchObject({ cause: { reasonCode: 'deadline-exceeded' } })
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.authorize).not.toHaveBeenCalled()
})

test('rejects retained facts for another account, a chained delegation, or a changed exact lookup', async () => {
  const f = fixture()
  for (const retained of [
    { ...f.retained, fact: { ...f.retained.fact, principalId: 'other' as Seat.SeatPrincipalId } },
    { ...f.retained, fact: { ...f.retained.fact, kind: 'node-delegation' as const } },
    { ...f.retained, request: { ...f.retained.request, payloadDigest: 'changed' as Seat.SeatDigest } },
  ]) {
    expect(await chainAuthority(f.request, f.peer, f.policy, async () => retained))
      .toMatchObject({ cause: { reasonCode: 'evidence-digest-mismatch' } })
  }
  expect(f.authorize).not.toHaveBeenCalled()
})
