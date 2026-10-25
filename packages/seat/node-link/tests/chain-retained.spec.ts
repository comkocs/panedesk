/** Sender evidence persists independently and cannot be queried by an unpaired node. */
import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PosixPrivateFiles } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { chainDigest, decodeChainRequest } from '../src/chain-codec.ts'
import { ChainRetainedEvidence, matchesChainGrant } from '../src/chain-retained.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const deadline = new Date(Date.now() + 30000).toISOString()
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'],
    operationId: 'operation-a', targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const request = decodeChainRequest({ version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline, hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'], expiresAt: deadline } })
  const fact: Seat.SeatIssuedAuthorizationFact = { authorizationId: request.delegation.authorizationRef, kind: 'human',
    principalId: request.delegation.principalId, origin: 'manual', nodeId: request.sourceNodeId, taskIds: request.delegation.taskIds,
    operationId: request.operationId, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
    requestDigest: request.payloadDigest, checkedAt: new Date().toISOString() }
  const grant = { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  const wanted: Seat.NodeDelegationEvidenceRequest = { authorizationRef: fact.authorizationId, method: request.method,
    operationId: request.operationId, payloadDigest: request.payloadDigest,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId }
  const peer = { sourceNodeId: request.targetNodeId, targetNodeId: request.sourceNodeId, authenticatedAt: fact.checkedAt }
  return { request, fact, grant, wanted, peer }
}

test('restores exact paired evidence, rejects mismatched grants, and expires entries without evicting live facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chain-retained-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!()), f = fixture()
  const first = new ChainRetainedEvidence(files, 65536, 1, 'node-a', 'node-b')
  await first.retain(f.request, f.grant)
  await first.close()
  const restored = new ChainRetainedEvidence(files, 65536, 1, 'node-a', 'node-b')
  await expect(restored.query(f.wanted, f.peer)).resolves.toMatchObject({ status: 'retained', fact: f.fact })
  await expect(restored.query(f.wanted, { ...f.peer, sourceNodeId: f.peer.targetNodeId })).resolves.toMatchObject({ status: 'rejected' })
  const changed = { ...f.grant, fact: { ...f.fact, principalId: 'other' as Seat.SeatPrincipalId } }
  expect(matchesChainGrant(f.request, changed)).toBe(false)
  await expect(restored.retain(f.request, changed)).rejects.toThrow('authority rejected')
  const next = { ...f.request, delegation: { ...f.request.delegation, authorizationRef: 'grant-b' as Seat.AuthorizationRef } }
  const grant = { ...f.grant, fact: { ...f.fact, authorizationId: next.delegation.authorizationRef } }
  await expect(restored.retain(next, grant)).rejects.toThrow('capacity exceeded')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 40000)
  await expect(restored.query(f.wanted, f.peer)).resolves.toMatchObject({ status: 'rejected' })
  const expired = new ChainRetainedEvidence(files, 65536, 1, 'node-a', 'node-b')
  await expired.ready()
  const fresh = fixture()
  await expect(expired.retain(fresh.request, fresh.grant)).resolves.toBeUndefined()
  await expired.close()
})

test('compares every grant-bound delegation field before any durable publication', () => {
  const f = fixture()
  for (const fact of [
    { ...f.fact, decision: 'denied' as const }, { ...f.fact, kind: 'node-delegation' as const },
    { ...f.fact, authorizationId: 'other' as Seat.AuthorizationRef }, { ...f.fact, nodeId: f.request.targetNodeId },
    { ...f.fact, operationId: 'other' as Seat.SeatOperationId }, { ...f.fact, requestDigest: 'other' as Seat.SeatDigest },
    { ...f.fact, seat: 'other' as Seat.SeatName }, { ...f.fact, taskIds: [] },
    { ...f.fact, sessionId: 'other' as NonNullable<Seat.SeatIssuedAuthorizationFact['sessionId']> },
  ]) expect(matchesChainGrant(f.request, { ...f.grant, fact })).toBe(false)
})
