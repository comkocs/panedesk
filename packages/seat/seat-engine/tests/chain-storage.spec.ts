/** Remote admission frames bind authority, frozen input and the complete business identity. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { authorizationFrame, decodeAuthorizationFrame } from '../src/authorization-storage.ts'
import { canonical, decodeFrame, digest, EngineJournal } from '../src/journal.ts'
import { validChainAccepted, type ChainAcceptedEffect } from '../src/chain-storage.ts'
import { auto, harness, nodeId, sourceId, trigger } from './fixtures.ts'
import { TriggerRegistry } from '../src/triggers.ts'
import { SourceRegistry } from '../src/sources.ts'
import { config } from './fixtures.ts'
import { freezeCallbackEvidence } from '../src/callback-evidence.ts'
import { fact } from '../src/triggers.ts'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CallbackOutbox } from '../src/outbox.ts'
import { admittedDefinition, persistCallback } from './routed-callback-fixture.ts'
import { seat } from './fixtures.ts'

test('rejects a diagnostic frame above maxDecisionBytes without truncating the original or clearing unknown', async () => {
  const h = await harness()
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine)
  const delivery = h.engine.journal.projection.callbacks.get(body.callback.callbackId)!
  const lastDiagnostic: T.SeatCallbackDiagnostic = { stage: 'writeback', cause: { domain: 'a'.repeat(128), code: 'b'.repeat(128),
    reason: 'é'.repeat(256), effectState: 'unknown', retryable: false, operationId: body.route.originalOperationId,
    nodeId, reasonCode: 'outcome-unknown' } }
  const metadata = { decisionId: 'decision-a' as T.EngineDecisionId, observedAt: '2026-01-01T00:00:00.000Z' }
  const attempted = fact({ kind: 'callback/attempted', data: { ...delivery, responseClass: 'unknown', lastDiagnostic } })
  const frame = authorizationFrame({ namespace: 'ledger/engine/v1', schemaVersion: 1, ...metadata,
    sequence: 2, nodeId, policyRevision: 0, effects: [attempted] })
  const bound = Buffer.byteLength(canonical(frame)) + 1
  const exact = new EngineJournal(join(h.home, 'exact'), nodeId, bound)
  const over = new EngineJournal(join(h.home, 'over'), nodeId, bound - 1)
  const sources = new SourceRegistry()
  try {
    for (const journal of [exact, over]) {
      await journal.ready()
      await journal.commit(() => [fact({ kind: 'callback/pending', data: { ...delivery, responseClass: 'unknown' } })], 0, metadata)
    }
    await exact.commit(() => [attempted], 0, metadata)
    const beforeNames = await readdir(join(over.root, 'events'))
    const before = await readFile(join(over.root, 'events', beforeNames[0]!), 'utf8')
    await expect(over.commit(() => [attempted], 0, metadata)).rejects.toMatchObject({ code: 'engine-store-corrupt' })
    expect(await readdir(join(over.root, 'events'))).toEqual(beforeNames)
    expect(await readFile(join(over.root, 'events', beforeNames[0]!), 'utf8')).toBe(before)
    expect(over.projection.callbacks.get(body.callback.callbackId)).toMatchObject({ responseClass: 'unknown', nodeWorkChain: body })
    const outbox = new CallbackOutbox(over, sources, h.engine.options.config, async () => ({ result: { status: 'pending',
      callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest }, diagnostic: lastDiagnostic }))
    try {
      await expect(outbox.deliver(0)).rejects.toMatchObject({ code: 'source-payload-too-large' })
      expect(over.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    } finally { await outbox.close() }
    expect(exact.projection.callbacks.get(body.callback.callbackId)?.lastDiagnostic).toEqual(lastDiagnostic)
  } finally { await sources.close(); await exact.close(); await over.close(); await h.close() }
})

async function fixture() {
  const h = await harness()
  await h.engine.accept(trigger())
  const frame = h.engine.journal.projection.authorizationDecisions[0]!
  const intent = frame.effects.find(effect => effect.kind === 'trigger/accepted')
  if (!intent || intent.kind !== 'trigger/accepted') throw new Error('Expected a retained trigger')
  const operationId = 'remote-operation' as T.SeatOperationId
  const principalId = 'principal' as T.SeatPrincipalId
  const sourceNodeId = 'source-node' as T.SeatNodeId
  h.definitions.get(intent.seat!)!.remoteAdmission = { allowOpen: true, sourceNodeIds: [sourceNodeId], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen'], policyRevision: 1 }
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
      principalId, sourceNodeId, origin: 'remote', nodeId, operationId, requestDigest: data.payloadDigest, taskIds: [],
      policyRevision: 1, decision: 'allowed', reasonCode: 'allowed', checkedAt: frame.observedAt, seat: intent.seat! } }
  const { digest: _digest, byteLength: _length, ...body } = frame
  const decision = authorizationFrame({ ...body, requiredCapabilities: ['node-work-chain/v1'], effects: [
    { ...intent, operationId, data: { ...intent.data, pending: { ...intent.data.pending,
      frozenOpen: { ...frozen, nodeWorkChain: data } } } }, accepted, authorization,
  ] })
  const registerRetention = (engine: typeof h.engine) => engine.registerPreopenRetention({
    projectId: intent.data.trigger.projectId, sourceId: data.route.sourceId,
    sourceOwnerNodeId: data.route.sourceOwnerNodeId, limitMs: 900000,
  })
  h.ctx.effect(() => registerRetention(h.engine))
  return { h, decision, data, accepted, authorization, registerRetention }
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
    for (const sourceNodeId of [undefined, 'other-source' as T.SeatNodeId]) {
      const effects = structuredClone(body.effects)
      for (const effect of effects) {
        if (effect.kind !== 'authorization/checked') continue
        if (sourceNodeId === undefined) delete effect.data.sourceNodeId
        else effect.data.sourceNodeId = sourceNodeId
      }
      expect(() => decodeAuthorizationFrame(canonical(authorizationFrame({ ...body, effects })), 200000)).toThrow('authorization does not match')
    }
    const { requiredCapabilities: _capability, ...missing } = body
    expect(() => decodeAuthorizationFrame(canonical(authorizationFrame(missing)), 200000)).toThrow('capability')
    expect(() => decodeAuthorizationFrame(canonical(authorizationFrame({ ...body,
      effects: body.effects.filter(effect => effect.kind === 'trigger/accepted') })), 200000)).toThrow('capability')
  } finally { await h.close() }
})

test('separates frozen owners and epochs without changing local coalescing', async () => {
  const { h, data } = await fixture()
  const sources = new SourceRegistry()
  sources.register({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
  const registry = new TriggerRegistry(h.engine.journal, sources, config)
  const frozen = [...h.engine.journal.projection.pending.values()][0]!.frozenOpen!
  try {
    for (const [index, ownerEpoch] of ['epoch-a', 'epoch-b', 'epoch-a'].entries()) {
      const result = await registry.accept(trigger('external', `chain-${index}`), undefined,
        { ...frozen, nodeWorkChain: { ...data, route: { ...data.route, ownerEpoch: ownerEpoch as T.OwnerEpoch } } })
      expect(result.status).toBe(index === 2 ? 'coalesced' : 'accepted')
    }
    expect(h.engine.journal.projection.pending.size).toBe(3)
  } finally { await sources.close(); await h.close() }
})

test.each(['off', 'remind'] as const)('retains the source %s ceiling across dispatch and recovery', async (mode) => {
  const { h, decision, registerRetention } = await fixture()
  try {
    const effects = structuredClone(decision.effects)
    for (const effect of effects) {
      if (effect.kind === 'node-route/accepted') effect.data.route.modeCeiling.mode = mode
      if (effect.kind === 'trigger/accepted' && effect.data.pending.frozenOpen?.nodeWorkChain) {
        effect.data.pending.frozenOpen.nodeWorkChain.route.modeCeiling.mode = mode
      }
    }
    await h.engine.journal.commitAuthorization(() => effects)
    await auto(h.engine)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect([...h.engine.journal.projection.pending.values()][0]?.reason).toBe(mode === 'off' ? 'project-off' : 'approval')
    await h.engine.shutdown()
    const restarted = await h.start()
    h.ctx.effect(() => registerRetention(restarted))
    await restarted.drive()
    expect(h.creates).toEqual([])
    expect([...restarted.journal.projection.pending.values()][0]?.effectiveMode).toBe(mode)
  } finally { await h.close() }
})

test('freezes execution evidence once and retains missing across replay and restart', async () => {
  const { h, decision } = await fixture()
  try {
    await h.engine.journal.commitAuthorization(() => decision.effects)
    await auto(h.engine)
    const effects = structuredClone(decision.effects)
    const intent = effects.find(effect => effect.kind === 'trigger/accepted')
    if (intent?.kind !== 'trigger/accepted') throw new Error('Expected trigger')
    await h.engine.approve({ queueItemId: intent.data.pending.queueItemId,
      expectedStateVersion: intent.data.pending.stateVersion, operationId: 'approve' as T.SeatOperationId })
    await h.engine.drive()
    const delivery = [...h.engine.journal.projection.callbacks.values()][0]!
    expect(delivery.nodeWorkChain?.modelEvidence.status).toBe('missing')
    const changed: T.SeatExecutionModelEvidence = { status: 'present', provider: 'execution-provider', model: 'execution-model',
      kind: 'request/header', sessionId: delivery.payload.sessionId!, nodeId,
      recordRef: 'record:1' as Extract<T.SeatExecutionModelEvidence, { status: 'present' }>['recordRef'], observedAt: new Date().toISOString() }
    let reads = 0
    const read = async () => { reads++; return changed }
    expect(await freezeCallbackEvidence(h.engine.journal.projection, [delivery], read)).toEqual([delivery])
    expect(reads).toBe(0)
    for (const evidence of [{ ...changed, nodeId: 'other-node' as T.SeatNodeId },
      { ...changed, sessionId: 'other-session' as typeof changed.sessionId }]) {
      const candidate = { ...delivery, payload: { ...delivery.payload, callbackId: 'mismatched' as T.CallbackId } }
      const [missing] = await freezeCallbackEvidence(h.engine.journal.projection, [candidate], async () => evidence)
      expect(missing?.nodeWorkChain?.modelEvidence).toMatchObject({ status: 'missing', nodeId,
        sessionId: delivery.payload.sessionId })
    }
    const unreadable = { ...delivery, payload: { ...delivery.payload, callbackId: 'unreadable' as T.CallbackId } }
    const [missing] = await freezeCallbackEvidence(h.engine.journal.projection, [unreadable], async () => { throw new Error('Unreadable record') })
    expect(missing?.nodeWorkChain?.modelEvidence.status).toBe('missing')
    const fresh: T.SeatCallbackDelivery = { ...delivery, payload: { ...delivery.payload, callbackId: 'fresh' as T.CallbackId } }
    fresh.payloadDigest = digest(fresh.payload)
    const [present] = await freezeCallbackEvidence(h.engine.journal.projection, [fresh], read)
    expect(present?.nodeWorkChain?.modelEvidence).toEqual(changed)
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: present! })])
    changed.model = 'later-model'
    expect(present?.nodeWorkChain?.modelEvidence).toMatchObject({ model: 'execution-model' })
    const upgraded = structuredClone(delivery)
    if (!upgraded.nodeWorkChain) throw new Error('Expected routed callback')
    upgraded.nodeWorkChain.modelEvidence = changed
    const { payloadDigest: _retainedDigest, ...upgradedBody } = upgraded.nodeWorkChain
    upgraded.nodeWorkChain.payloadDigest = digest(upgradedBody)
    await expect(h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: upgraded })]))
      .rejects.toThrow('Frozen callback evidence cannot change')
    const corrupted = structuredClone(present!)
    corrupted.payload.callbackId = 'corrupted' as T.CallbackId
    corrupted.payloadDigest = digest(corrupted.payload)
    await expect(h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: corrupted })]))
      .rejects.toThrow('Frozen callback evidence does not match')
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(restarted.journal.projection.callbacks.get(delivery.payload.callbackId)?.nodeWorkChain).toEqual(delivery.nodeWorkChain)
    expect(restarted.journal.projection.callbacks.get(fresh.payload.callbackId)?.nodeWorkChain).toEqual(present?.nodeWorkChain)
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
