/** Remote admission frames bind authority, frozen input and the complete business identity. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { authorizationFrame, decodeAuthorizationFrame } from '../src/authorization-storage.ts'
import { canonical, decodeFrame, digest, EngineJournal } from '../src/journal.ts'
import { validChainAccepted, type ChainAcceptedEffect } from '../src/chain-storage.ts'
import { harness, nodeId, sourceId, trigger } from './fixtures.ts'

async function fixture() {
  const h = await harness()
  await h.engine.accept(trigger())
  const frame = h.engine.journal.projection.authorizationDecisions[0]!
  const intent = frame.effects.find(effect => effect.kind === 'trigger/accepted')
  if (!intent || intent.kind !== 'trigger/accepted') throw new Error('Expected a retained trigger')
  const operationId = 'remote-operation' as T.SeatOperationId
  const principalId = 'principal' as T.SeatPrincipalId
  const sourceNodeId = 'source-node' as T.SeatNodeId
  const ownerEpoch = 'source-epoch' as T.OwnerEpoch
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'provider' as T.OpeningProviderId,
    reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen opening', digest: digest('Frozen opening'), revision: '1', taskIds: [], scopeEvidence: [] }
  const route: T.NodeWorkChainRoute = { sourceId, sourceOwnerNodeId: sourceNodeId, ownerEpoch,
    triggerId: intent.data.trigger.triggerId, originalOperationId: operationId, targetNodeId: nodeId,
    snapshotDigest: snapshot.digest, callbackPath: { kind: 'source', sourceId },
    modeCeiling: { mode: 'remind', policy: { sourceId, projectId: intent.data.trigger.projectId, revision: 1 } } }
  const data: T.NodeWorkChainAcceptedData = { capability: 'node-work-chain/v1', route,
    openingContext: { snapshot, openingMode: 'auto', scopeReservation: { reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'],
      sourceId, sourceOwnerNodeId: sourceNodeId, ownerEpoch, operationId, taskIds: [],
      snapshotDigest: snapshot.digest, policyRevision: 1 } },
    expectedSeatRevision: 1, authorizationRef: 'authorization' as T.AuthorizationRef, payloadDigest: digest('payload'),
    operationKey: { sourceNodeId, principalId, sourceId, ownerEpoch, method: 'engine.acceptFrozen', operationId }, trigger: intent.data.trigger }
  const frozen = intent.data.pending.frozenOpen
  if (!frozen) throw new Error('Expected frozen input')
  const accepted: ChainAcceptedEffect = { kind: 'node-route/accepted', eventId: 'route-event' as T.EngineEventId,
    operationId, seat: intent.seat!, data }
  const authorization: import('../src/authorization-storage.ts').AuthorizationEffect = {
    kind: 'authorization/checked', capability: 'seat-authorization/v1', eventId: 'authorization-event' as T.EngineEventId,
    operationId, seat: intent.seat!, data: { authorizationId: data.authorizationRef, kind: 'node-delegation',
      principalId, origin: 'remote', nodeId, operationId, requestDigest: data.payloadDigest, taskIds: [],
      policyRevision: 1, decision: 'allowed', reasonCode: 'allowed', checkedAt: frame.observedAt, seat: intent.seat! } }
  const { digest: _digest, byteLength: _length, ...body } = frame
  const decision = authorizationFrame({ ...body, requiredCapabilities: ['node-work-chain/v1'], effects: [
    { ...intent, operationId, data: { ...intent.data, pending: { ...intent.data.pending,
      frozenOpen: { ...frozen, nodeWorkChain: data } } } }, accepted, authorization,
  ] })
  return { h, decision, data, accepted, authorization }
}

test('requires the route capability and matching intent in one frame, refusing legacy readers', async () => {
  const { h, decision } = await fixture()
  try {
    const bytes = canonical(decision)
    expect(decodeAuthorizationFrame(bytes, 200000)).toEqual(decision)
    expect(() => decodeFrame(bytes, 200000)).toThrow('Invalid engine effect')
    const { digest: _digest, byteLength: _length, ...body } = decision
    for (const effects of [body.effects.filter(effect => effect.kind !== 'authorization/checked'),
      body.effects.filter(effect => effect.kind !== 'trigger/accepted')]) {
      expect(() => decodeAuthorizationFrame(canonical(authorizationFrame({ ...body, effects })), 200000)).toThrow()
    }
    const { requiredCapabilities: _capability, ...missing } = body
    expect(() => decodeAuthorizationFrame(canonical(authorizationFrame(missing)), 200000)).toThrow('capability')
    expect(() => decodeAuthorizationFrame(canonical(authorizationFrame({ ...body,
      effects: body.effects.filter(effect => effect.kind === 'trigger/accepted') })), 200000)).toThrow('capability')
  } finally { await h.close() }
})

test('checks complete frozen evidence and rejects conflicting identities before append', async () => {
  const { h, decision, data } = await fixture()
  const journal = new EngineJournal(`${h.home}/chain`, nodeId, 200000)
  try {
    expect(validChainAccepted(data)).toBe(true)
    for (const changed of [
      { ...data, operationKey: { ...data.operationKey, sourceId: 'other' } },
      { ...data, operationKey: { ...data.operationKey, callbackId: 'unrelated' } },
      { ...data, openingContext: { ...data.openingContext, snapshot: { ...data.openingContext.snapshot, text: 'changed' } } },
      { ...data, route: { ...data.route, ownerEpoch: 'other' } },
      { ...data, expectedSeatRevision: 0 },
    ]) expect(validChainAccepted(changed)).toBe(false)
    await journal.ready()
    await journal.commitAuthorization(() => decision.effects)
    expect(journal.projection.authorizationDecisions[0]?.requiredCapabilities).toEqual(['node-work-chain/v1'])
    await expect(journal.commitAuthorization(() => decision.effects)).rejects.toThrow('already admitted')
    expect(journal.projection.sequence).toBe(1)
    await journal.close()
    const reopened = new EngineJournal(journal.root, nodeId, 200000)
    try {
      await reopened.ready()
      expect(reopened.projection.authorizationDecisions[0]?.effects).toEqual(decision.effects)
      expect(reopened.projection.pending.size).toBe(1)
    } finally { await reopened.close() }
  } finally { await journal.close(); await h.close() }
})
