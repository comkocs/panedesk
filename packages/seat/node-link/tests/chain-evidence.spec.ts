/** Exact evidence crosses an authenticated channel and consumes an independent bounded slot. */
import { randomBytes } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { listenAuthenticatedLoopback } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainEvidence } from '../src/chain-evidence.ts'
import type { ChainCapability } from '../src/chain-types.ts'
import type { NodeLinkRuntimeConfig } from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const capability: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: 65536, methods: ['source.prepareOpening'] }
const options: NodeLinkRuntimeConfig = { nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', directory: 'unused',
  listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 1,
  maxStoreBytes: 65536, maxOperations: 10, staleMs: 1000 }
const request: Seat.NodeDelegationEvidenceRequest = { authorizationRef: 'grant-a' as Seat.NodeDelegationEvidenceRequest['authorizationRef'],
  method: 'source.prepareOpening', operationId: 'operation-a' as Seat.SeatOperationId, payloadDigest: 'digest-a' as Seat.SeatDigest,
  sourceNodeId: 'node-a' as Seat.SeatNodeId, targetNodeId: 'node-b' as Seat.SeatNodeId }

function evidence(): Extract<Seat.NodeDelegationEvidenceResult, { status: 'retained' }> {
  return { status: 'retained', request, expiresAt: '2099-01-01T00:00:00.000Z', revoked: false,
    fact: { authorizationId: request.authorizationRef, kind: 'human', principalId: 'principal-a' as Seat.SeatPrincipalId,
      origin: 'manual', nodeId: request.sourceNodeId, taskIds: [], operationId: request.operationId, policyRevision: 1,
      decision: 'allowed', reasonCode: 'allowed', requestDigest: request.payloadDigest, checkedAt: new Date().toISOString() } }
}

test('fetches only the exact retained request for the authenticated peer over the existing channel', async () => {
  const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-a', sourceNodeId: 'node-b', targetNodeId: 'node-a' }
  let calls = 0
  const server = new ChainEvidence(options, 1, { ready: async () => {}, query: async (wanted, peer) => {
    calls++
    expect(wanted).toEqual(request)
    expect(peer.sourceNodeId).toBe('node-b')
    expect(peer.targetNodeId).toBe('node-a')
    return evidence()
  } }, () => auth, () => capability)
  const listener = await listenAuthenticatedLoopback(0, options, () => auth, value => server.receive(value))
  cleanups.push(() => listener.close())
  const client = new ChainEvidence({ ...options, nodeId: 'node-b', peerNodeId: 'node-a', peerPort: listener.port }, 1,
    { ready: async () => {}, query: async () => { throw new Error('Unexpected local evidence read') } }, () => auth, () => capability)
  expect(await client.query(request)).toMatchObject({ status: 'retained', request })
  expect(calls).toBe(1)
  await expect(client.query({ ...request, sourceNodeId: request.targetNodeId })).rejects.toThrow('channel unavailable')
  expect(calls).toBe(1)
})

test('refuses legacy peer capability and cross-peer evidence without exposing retained entries', async () => {
  const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-a', sourceNodeId: 'node-b', targetNodeId: 'node-a' }
  let calls = 0
  const service = { ready: async () => {}, query: async () => { calls++; return evidence() } }
  const server = new ChainEvidence(options, 1, service, () => auth, () => undefined)
  await expect(server.query(request)).rejects.toThrow('channel unavailable')
  await expect(server.receive({ type: 'delegation-evidence', version: 'node-link/v1', requestId: 'evidence-a',
    request: { ...request, targetNodeId: 'node-c' } })).rejects.toThrow('peer rejected')
  expect(calls).toBe(0)
})
