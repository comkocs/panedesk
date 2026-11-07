/** Real ingress commits original business identity and recovers its exact first acknowledgement. */
import { expect, test, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { SeatEngine } from '../src/engine.ts'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { harness, nodeId, sourceId, seat, trigger } from './fixtures.ts'
import { digest, EngineJournal } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { authorizationEffect } from '../src/authorization-issuer.ts'
import { frozenIdentity, queryFrozen } from '../src/frozen-admission.ts'
import { retentionSince } from '../src/execution-recheck.ts'
import { frozenItems, queryFrozenExecution, preopenCancelledReason } from '../src/frozen-terminal.ts'
import { preopenCallback, withPreopenCallbacks } from '../src/preopen-callback.ts'
import { recoverPreopenCallbacks } from '../src/preopen-recovery.ts'

function request(): T.AcceptFrozenTriggerRequest {
  const envelope = trigger(), operationId = 'frozen-operation' as T.SeatOperationId
  const ownerEpoch = 'owner-epoch' as T.OwnerEpoch, owner = 'owner-node' as T.SeatNodeId
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'provider' as T.OpeningProviderId,
    reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen text',
  digest: digest('Frozen text'), revision: '1', taskIds: [], scopeEvidence: [] }
  return { envelope, expectedSeatRevision: 1, openingContext: { snapshot, openingMode: 'auto', scopeReservation: {
    reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'], sourceId, sourceOwnerNodeId: owner,
    ownerEpoch, operationId, taskIds: [], snapshotDigest: snapshot.digest, policyRevision: 1 } },
  route: { sourceId, sourceOwnerNodeId: owner, ownerEpoch, triggerId: envelope.triggerId, originalOperationId: operationId,
    targetNodeId: nodeId, snapshotDigest: snapshot.digest, callbackPath: { kind: 'source', sourceId },
    modeCeiling: { mode: 'remind', policy: { sourceId, projectId: envelope.projectId, revision: 1 } } } }
}

async function setup() {
  const h = await harness({ ownerObserveIntervalMs: 60000 }), input = request(), sender = 'sending-node' as T.SeatNodeId
  const principalId = 'principal' as T.SeatPrincipalId
  h.definitions.get(seat)!.remoteAdmission = { allowOpen: true, sourceNodeIds: [sender], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen'], policyRevision: 1 }
  const authorize = async (payload: T.AcceptFrozenTriggerRequest | T.OpenFrozenSeatRequest = input,
    engine = h.engine, sourceNodeId: T.SeatNodeId | undefined = sender) => {
    const entry = engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId, origin: 'remote', seat, taskIds: [], policyRevision: 1, ...(sourceNodeId ? { sourceNodeId } : {}) },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId: payload.route.originalOperationId, requestDigest: digest(payload) })
    if ('status' in grant) throw new Error('Expected grant')
    return { principalId, nodeId, origin: 'remote' as const, authorization: grant }
  }
  return { h, input, authorize }
}

test.each(['off', 'remind', 'auto'] as const)('inherits saved %s in the frozen admission transaction', async (mode) => {
  const { h, input, authorize } = await setup()
  try {
    input.route.modeCeiling.mode = 'auto'
    h.engine.registerProjectPolicyResolver(() => mode)
    expect(await h.engine.acceptFrozen(input, await authorize())).toMatchObject({ status: mode === 'off' ? 'rejected' : 'accepted' })
    expect(await h.engine.projectPolicy(input.envelope.projectId)).toMatchObject({ mode, modeChosen: true, revision: 1 })
    const effects = h.engine.journal.projection.authorizationDecisions.at(-1)!.effects
    expect(effects.some(effect => effect.kind === 'mode/changed')).toBe(true)
    expect(effects.some(effect => effect.kind === (mode === 'off' ? 'source/rejected' : 'trigger/accepted'))).toBe(true)
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test.each(['manual', 'engine'] as const)('uses verified %s authority rather than claimed manual origin under off', async (origin) => {
  const { h, input } = await setup()
  try {
    await h.engine.setProjectMode({ projectId: input.envelope.projectId, mode: 'off', expectedRevision: 0,
      operationId: 'off-owner-test' as T.SeatOperationId })
    input.route.modeCeiling.mode = 'off'
    const payload: T.OpenFrozenSeatRequest = { request: { seat, operationId: input.route.originalOperationId,
      origin: 'manual', openingMode: 'auto' }, expectedSeatRevision: 1, openingContext: input.openingContext,
    route: { ...input.route, triggerId: null } }
    h.definitions.get(seat)!.remoteAdmission!.methods = ['seat.openFrozen']
    const principalId = 'principal' as T.SeatPrincipalId
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId, origin, seat, sourceNodeId: 'sending-node' as T.SeatNodeId, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'trusted-node-chain', policyRevision: 1 }) })
    const grant = await entry.issuer.check({ operationId: payload.request.operationId, requestDigest: digest(payload) })
    if ('status' in grant) throw new Error('Expected grant')
    const authority: T.SeatCallContext = { nodeId, principalId, origin, authorization: grant }
    const chain = frozenIdentity(payload, authority, 'seat.openFrozen')
    if ('status' in chain) throw new Error('Expected frozen identity')
    const result = await h.engine.openWindow({ request: payload.request, authority, nodeWorkChain: chain,
      definition: structuredClone(h.definitions.get(seat)!), title: 'Owner opening', openingContext: payload.openingContext.snapshot,
      opening: { text: payload.openingContext.snapshot.text, digest: payload.openingContext.snapshot.digest,
        variables: { seat, date: '2026-01-01', taskId: null } } })
    if (origin === 'engine') {
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'disabled' } })
      expect(h.creates).toHaveLength(0)
      return
    }
    expect(result).toMatchObject({ status: 'queued' })
    entry.dispose()
    await h.engine.shutdown()
    const restarted = await h.start()
    restarted.registerLocalAccess(executionAccess(h))
    restarted.registerPreopenRetention({ projectId: input.envelope.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 900000 })
    await restarted.drive()
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test('admits a missing replay once and returns its result to the late original after restart', async () => {
  const { h, input, authorize } = await setup()
  try {
    const original = structuredClone(input), authority = await authorize()
    const key: T.NodeWorkChainOperationKey = { sourceNodeId: authority.authorization.fact.sourceNodeId!,
      principalId: authority.principalId, sourceId: input.route.sourceId, ownerEpoch: input.route.ownerEpoch,
      method: 'engine.acceptFrozen', operationId: input.route.originalOperationId }
    const query = { key, payloadDigest: digest(input) }
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual({ status: 'missing' })
    const replay = await h.engine.acceptFrozen(input, authority)
    expect(replay).toMatchObject({ status: 'accepted' })
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.acceptFrozen(original, await authorize(original, restarted))).toEqual(replay)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual({ status: 'settled', method: key.method, result: replay })
    expect(restarted.journal.projection.authorizationDecisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'trigger/accepted')).toHaveLength(1)
  } finally { await h.close() }
})

test('returns the original frozen acceptance on concurrent retry and after recovery', async () => {
  const { h, input, authorize } = await setup()
  try {
    const authority = await authorize()
    const results = await Promise.all([h.engine.acceptFrozen(input, authority), h.engine.acceptFrozen(input, await authorize())])
    expect(results[0]).toMatchObject({ status: 'accepted' })
    expect(results[1]).toEqual(results[0])
    expect(h.engine.journal.projection.authorizationDecisions).toHaveLength(1)
    expect(h.engine.journal.projection.authorizationDecisions[0]?.effects.map(effect => effect.kind))
      .toEqual(['trigger/accepted', 'node-route/accepted', 'queue/reminded', 'authorization/checked'])
    const accepted = h.engine.journal.projection.authorizationDecisions[0]?.effects.find(effect => effect.kind === 'node-route/accepted')
    if (accepted?.kind !== 'node-route/accepted') throw new Error('Expected admission')
    expect(accepted.data.operationKey.sourceNodeId).not.toBe(accepted.data.route.sourceOwnerNodeId)
    const query = { key: accepted.data.operationKey, payloadDigest: digest(input) }
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual({ status: 'settled', method: 'engine.acceptFrozen', result: results[0] })
    const changed = { ...input, envelope: { ...input.envelope, data: 'changed', dataDigest: digest('changed') } }
    expect(await h.engine.acceptFrozen(changed, await authorize(changed))).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    expect(queryFrozen(h.engine.journal.projection, { ...query, payloadDigest: digest(changed) })).toMatchObject({ status: 'rejected' })
    h.definitions.clear()
    h.engine.authorizationIssuers.close()
    expect(await h.engine.acceptFrozen(input, authority)).toEqual(results[0])
    expect(await h.engine.acceptFrozen(changed, { ...authority, authorization: {
      ...authority.authorization, fact: { ...authority.authorization.fact, requestDigest: digest(changed) } } }))
      .toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    await h.engine.shutdown()
    await writeFile(join(h.engine.journal.root, 'events', '9999999999999999-interrupted.jsonl'), '{"sequence":2')
    const restarted = await h.start()
    expect(queryFrozen(restarted.journal.projection, query)).toEqual({ status: 'settled', method: 'engine.acceptFrozen', result: results[0] })
    expect(await restarted.acceptFrozen(input, await authorize(input, restarted))).toEqual(results[0])
    expect(restarted.journal.projection.authorizationDecisions).toHaveLength(1)
  } finally { await h.close() }
})

test('revokes new frozen writes before shutdown drains an admitted call', async () => {
  const { h, input, authorize } = await setup()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  try {
    const authority = await authorize()
    const resolve = h.seatProvider.resolve.bind(h.seatProvider)
    vi.spyOn(h.seatProvider, 'resolve').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return resolve(...args)
    })
    const active = h.engine.acceptFrozen(input, authority)
    await entered.promise
    let drained = false
    const closing = h.engine.shutdown().then(() => { drained = true })
    expect(await h.engine.acceptFrozen(input, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(drained).toBe(false)
    release.resolve(undefined)
    expect(await active).toMatchObject({ status: 'accepted' })
    await closing
    expect(await h.engine.acceptFrozen(input, authority)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  } finally { release.resolve(undefined); vi.restoreAllMocks(); await h.close() }
})

function executionAccess(h: Awaited<ReturnType<typeof harness>>, recheck = vi.fn(async (): Promise<T.SeatRejected | null> => null)) {
  return { list: () => h.seatProvider.list(), close: (input: T.CloseSeatRequest) => h.seatProvider.close(input),
    freeze: async (definition: T.SeatDefinition) => ({ definition, title: 'Frozen', openingMode: 'auto' as const }), recheck }
}

async function admitForExecution(kind: 'remote-source' | 'owner-target') {
  const setupResult = await setup(), { h, input, authorize } = setupResult
  const recheck = vi.fn(async (): Promise<T.SeatRejected | null> => null)
  h.engine.registerLocalAccess(executionAccess(h, recheck))
  if (kind === 'owner-target') {
    input.route.sourceOwnerNodeId = nodeId
    input.openingContext.scopeReservation.sourceOwnerNodeId = nodeId
    const payload: T.OpenFrozenSeatRequest = { request: { seat, operationId: input.route.originalOperationId,
      origin: 'remote', openingMode: 'auto' }, expectedSeatRevision: input.expectedSeatRevision,
    openingContext: input.openingContext, route: { ...input.route, triggerId: null } }
    h.definitions.get(seat)!.remoteAdmission!.methods = ['seat.openFrozen']
    const authority = await authorize(payload), chain = frozenIdentity(payload, authority, 'seat.openFrozen')
    if ('status' in chain) throw new Error('Expected frozen identity')
    expect(await h.engine.openWindow({ request: payload.request, authority, nodeWorkChain: chain,
      definition: structuredClone(h.definitions.get(seat)!), title: 'Frozen', openingContext: payload.openingContext.snapshot,
      opening: { text: payload.openingContext.snapshot.text, digest: payload.openingContext.snapshot.digest,
        variables: { seat, date: '2026-01-01', taskId: null } } })).toMatchObject({ status: 'queued' })
  } else {
    expect(await h.engine.acceptFrozen(input, await authorize())).toMatchObject({ status: 'accepted' })
  }
  const pending = [...h.engine.journal.projection.pending.values()][0]!
  const query = { key: pending.frozenOpen!.nodeWorkChain!.operationKey,
    payloadDigest: pending.frozenOpen!.nodeWorkChain!.payloadDigest }
  const original = queryFrozen(h.engine.journal.projection, query)
  const removeRetention = h.engine.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
    sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 900000 })
  return { ...setupResult, recheck, pending, query, original, removeRetention }
}

async function approveForExecution(h: Awaited<ReturnType<typeof harness>>, pending: T.PendingSeatItem) {
  expect(await h.engine.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'approve-a' as T.SeatOperationId })).toMatchObject({ status: 'approved' })
}

test('queries the executed frozen window while preserving its original queued receipt', async () => {
  const { h, pending, query, original } = await admitForExecution('owner-target')
  try {
    await approveForExecution(h, pending)
    await h.engine.drive()
    const open = [...h.engine.journal.projection.opens.values()][0]
    if (!open) throw new Error('Expected retained execution')
    expect(queryFrozenExecution(h.engine.journal.projection, query)).toMatchObject({ status: 'settled',
      method: 'seat.openFrozen', result: { status: 'opened', sessionId: open.sessionId } })
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    expect(queryFrozenExecution(h.engine.journal.projection, { ...query, payloadDigest: digest('different') }))
      .toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(queryFrozenExecution(restarted.journal.projection, query)).toMatchObject({ status: 'settled',
      method: 'seat.openFrozen', result: { status: 'opened', sessionId: open.sessionId } })
    await restarted.recordClosed({ sessionId: open.sessionId, phase: 'closed', reason: 'manual', stateVersion: 1,
      endedAt: new Date().toISOString(), reportId: null, selfReport: null, selfReportStatus: 'not-submitted' })
    expect(restarted.journal.projection.closed.has(open.sessionId)).toBe(true)
    expect(queryFrozenExecution(restarted.journal.projection, query)).toMatchObject({ result: {
      status: 'opened', sessionId: open.sessionId, phase: open.phase } })
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test.each(['intent', 'creating', 'created', 'configuring', 'opening-pending', 'active', 'opening-failed'] as const)(
  'queries retained frozen opening phase %s without inventing completion', async (phase) => {
    const { h, pending, query, original } = await admitForExecution('owner-target')
    try {
      await approveForExecution(h, pending)
      await h.engine.drive()
      const view = h.engine.journal.projection, open = [...view.opens.values()][0]
      if (!open) throw new Error('Expected retained execution')
      view.opens.set(open.sessionId, { ...open, phase })
      const result = queryFrozenExecution(view, query)
      if (phase === 'intent' || phase === 'creating') expect(result).toEqual(original)
      else expect(result).toMatchObject({ status: 'settled', method: 'seat.openFrozen', result: {
        status: 'opened', sessionId: open.sessionId, phase, nodeName: h.engine.options.nodeId, callbackIds: [] } })
      expect(queryFrozen(view, query)).toEqual(original)
      view.opens.set(open.sessionId, open)
    } finally { await h.close() }
  })

test('queries prefill, no-effect failure and ambiguous frozen execution from retained evidence', async () => {
  const { h, pending, query, original } = await admitForExecution('owner-target')
  try {
    await approveForExecution(h, pending)
    await h.engine.drive()
    const view = h.engine.journal.projection, open = [...view.opens.values()][0]
    if (!open) throw new Error('Expected retained execution')
    const prefill = { ...open, openingMode: 'prefill' as const, phase: 'active' as const }
    view.opens.set(open.sessionId, prefill)
    expect(queryFrozenExecution(view, query)).toMatchObject({ result: { status: 'prefilled', draft: 'Frozen text' } })
    const { frozenOpening: _opening, ...withoutDraft } = prefill
    view.opens.set(open.sessionId, withoutDraft)
    expect(queryFrozenExecution(view, query)).toMatchObject({ result: { status: 'opened', phase: 'active' } })
    const failure: T.SeatFailure = { code: 'unavailable', message: 'Creation refused', alternative: 'Inspect the original operation.',
      retryable: false, effectState: 'none' }
    view.opens.set(open.sessionId, { ...open, phase: 'opening-failed', failure })
    expect(queryFrozenExecution(view, query)).toEqual({ status: 'settled', method: 'seat.openFrozen',
      result: { status: 'rejected', error: failure } })
    view.opens.set(open.sessionId, { ...open, phase: 'opening-failed', failure: { ...failure, effectState: 'partial' } })
    expect(queryFrozenExecution(view, query)).toMatchObject({ result: { status: 'opened', phase: 'opening-failed', sessionId: open.sessionId } })
    const other = 'ambiguous-session' as typeof open.sessionId
    view.opens.set(other, { ...open, sessionId: other })
    expect(queryFrozenExecution(view, query)).toEqual(original)
    view.opens.delete(other)
    view.opens.set(open.sessionId, open)
  } finally { await h.close() }
})

test.each(['remote-source', 'owner-target'] as const)('refuses a changed frozen target revision before dispatch for %s', async (kind) => {
  const { h, pending, query, original, recheck } = await admitForExecution(kind)
  try {
    await h.engine.drive()
    expect(h.creates).toEqual([])
    h.definitions.get(seat)!.revision++
    await approveForExecution(h, h.engine.journal.projection.pending.get(pending.queueItemId)!)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect(h.engine.journal.projection.pending.size).toBe(0)
    expect(h.engine.journal.projection.opens.size).toBe(0)
    expect(h.engine.journal.projection.resources.size).toBe(0)
    expect(h.engine.journal.projection.decisions.flatMap(item => item.effects)
      .filter(effect => effect.kind === 'open/rejected')).toMatchObject([
      { kind: 'open/rejected', data: { error: { code: 'revision-conflict', effectState: 'none' }, candidates: [] } } ])
    expect(pending.frozenOpen!.nodeWorkChain!.expectedSeatRevision).toBe(1)
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    expect(recheck).toHaveBeenCalledTimes(1)
  } finally { await h.close() }
})

test.each(['remote-source', 'owner-target'] as const)('executes unchanged frozen permission once without renewing the original grant for %s', async (kind) => {
  const { h, pending, query, original, recheck } = await admitForExecution(kind)
  try {
    h.engine.authorizationIssuers.close()
    await approveForExecution(h, pending)
    await h.engine.drive()
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    expect(h.engine.journal.projection.opens.size).toBe(1)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(queryFrozen(h.engine.journal.projection, query)).toEqual(original)
    const frames = structuredClone(h.engine.journal.projection.authorizationDecisions)
    await h.engine.shutdown()
    const restarted = await h.start()
    restarted.registerLocalAccess(executionAccess(h))
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.authorizationDecisions).toEqual(frames)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual(original)
  } finally { await h.close() }
})

test('rechecks the frozen target revision after an asynchronous source policy check', async () => {
  const { h, pending, recheck } = await admitForExecution('owner-target')
  try {
    recheck.mockImplementation(async () => {
      h.definitions.get(seat)!.revision++
      return null
    })
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect(h.engine.journal.projection.opens.size).toBe(0)
  } finally { await h.close() }
})

test('rechecks the frozen target after dispatch commits and before creating a window', async () => {
  const { h, pending } = await admitForExecution('owner-target')
  try {
    h.ctx.on('seat/decision', (decision) => {
      if (decision.effects.some(effect => effect.kind === 'open/intent')) h.definitions.get(seat)!.revision++
    })
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect([...h.engine.journal.projection.opens.values()]).toMatchObject([
      { phase: 'opening-failed', failure: { code: 'revision-conflict', effectState: 'none' } } ])
    expect(h.engine.journal.projection.resources.size).toBe(0)
  } finally { await h.close() }
})

test('rechecks the frozen target after restart before unfinished configuration or opening', async () => {
  const { h, pending, query, original } = await admitForExecution('owner-target')
  try {
    h.executor.configure = async () => { throw new Error('Interrupted configuration') }
    await approveForExecution(h, pending)
    await expect(h.engine.drive()).rejects.toThrow('Interrupted configuration')
    expect(h.creates).toHaveLength(1)
    const frames = structuredClone(h.engine.journal.projection.authorizationDecisions)
    await h.engine.shutdown()
    h.definitions.get(seat)!.revision++
    const configure = vi.fn(async () => {}), opening = vi.spyOn(h.executor, 'opening')
    h.executor.configure = configure
    const restarted = await h.start()
    restarted.registerLocalAccess(executionAccess(h))
    await restarted.drive()
    expect(configure).not.toHaveBeenCalled()
    expect(opening).not.toHaveBeenCalled()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.authorizationDecisions).toEqual(frames)
    expect(queryFrozen(restarted.journal.projection, query)).toEqual(original)
  } finally { await h.close() }
})

test('commits one rejected owner callback with a pre-open cancellation and keeps the original receipt', async () => {
  const { h, input, authorize } = await setup()
  try {
    const receipt = await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'cancel-frozen' as T.SeatOperationId })
    const terminal = h.engine.journal.projection.decisions.at(-1)!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['queue/cancelled', 'callback/pending'])
    const callbacks = terminal.effects.filter(effect => effect.kind === 'callback/pending')
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]?.data).toMatchObject({ payload: { kind: 'rejected', sessionId: null,
      reason: { code: 'gate-denied', effectState: 'none', retryable: false } }, nodeWorkChain: { route: input.route } })
    expect(await h.engine.acceptFrozen(input, await authorize())).toEqual(receipt)
    expect(h.creates).toEqual([])
  } finally { await h.close() }
})

test('reports a cancelled frozen source as rejected while replaying its first receipt', async () => {
  const { h, input, authorize } = await setup()
  try {
    const receipt = await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'terminal-query-cancel' as T.SeatOperationId })
    expect(await h.engine.authorizations.operation({ operationId: input.route.originalOperationId }))
      .toMatchObject({ status: 'settled', result: { status: 'rejected', error: { code: 'gate-denied', effectState: 'none' } } })
    expect(await h.engine.acceptFrozen(input, await authorize())).toEqual(receipt)
  } finally { await h.close() }
})

test('keeps an unregistered frozen route queued and still permits manual cancellation', async () => {
  const { h, pending, removeRetention } = await admitForExecution('remote-source')
  try {
    await removeRetention()
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toHaveLength(0)
    const current = h.engine.journal.projection.pending.get(pending.queueItemId)!
    expect(current).toMatchObject({ reason: 'provider-unavailable', blockedBy: ['provider-unavailable'] })
    await h.engine.cancel({ queueItemId: current.queueItemId, expectedStateVersion: current.stateVersion,
      operationId: 'unregistered-cancel' as T.SeatOperationId })
    expect([...h.engine.journal.projection.callbacks.values()]).toHaveLength(1)
  } finally { await h.close() }
})

test('expires retained frozen work at its original committed time even without providers or an executor', async () => {
  const { h, pending, input, recheck, query, original, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now'), ctx = new Context()
  let restarted: SeatEngine | undefined
  try {
    await removeRetention()
    h.engine.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 })
    recheck.mockResolvedValue({ status: 'rejected', error: { code: 'unavailable', message: 'Not ready',
      alternative: 'Retry', retryable: true, effectState: 'none' } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    expect(Number.isFinite(since)).toBe(true)
    const current = h.engine.journal.projection.pending.get(pending.queueItemId)!
    await approveForExecution(h, current)
    await h.engine.drive()
    expect(retentionSince(h.engine.journal.projection, pending.queueItemId)).toBe(since)
    clock.mockReturnValue(since + 999)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    await h.engine.shutdown()
    restarted = new SeatEngine(ctx, h.engine.options, { seats: () => undefined, ledger: () => undefined })
    await restarted.ready()
    restarted.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 })
    clock.mockReturnValue(since + 1000)
    await restarted.drive()
    expect(restarted.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    const terminal = restarted.journal.projection.decisions.findLast(frame => frame.effects.some(effect => effect.kind === 'queue/cancelled'))!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['open/rejected', 'queue/cancelled', 'callback/pending'])
    expect(queryFrozenExecution(restarted.journal.projection, query)).toMatchObject({ status: 'settled',
      result: { status: 'rejected', error: { code: 'gate-denied', retryable: false, effectState: 'none' } } })
    expect(queryFrozen(restarted.journal.projection, query)).toEqual(original)
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await restarted?.shutdown(); await ctx.fiber.dispose(); await h.close() }
})

test('projects retention time and committed expiry without changing old journal frames', async () => {
  const { h, input, authorize } = await setup(), clock = vi.spyOn(Date, 'now')
  try {
    await h.engine.acceptFrozen(input, await authorize())
    expect((await h.engine.pending({ limit: 10 })).items[0]).not.toHaveProperty('retention')
    await h.engine.drive()
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    const history = h.engine.journal.projection.decisions.map(frame => frame.digest)
    for (const [elapsed, phase, remainingMs] of [[0, 'retained', 900000], [600000, 'expiring', 300000],
      [899999, 'expiring', 1], [900000, 'expired', 0]] as const) {
      clock.mockReturnValue(since + elapsed)
      expect((await h.engine.pending({ limit: 10 })).items[0]).toMatchObject({
        retention: { since, deadline: since + 900000, remainingMs, phase } })
    }
    expect(h.engine.journal.projection.decisions.map(frame => frame.digest)).toEqual(history)
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)).not.toHaveProperty('retention')
    await h.engine.drive()
    expect(await h.engine.pending({ limit: 10, includeRejected: true })).toMatchObject({ items: [], rejected: [{
      item: { queueItemId: pending.queueItemId }, error: { code: 'gate-denied', message: 'Pre-open retention limit reached' },
    }] })
    const terminalPage = await h.engine.pending({ limit: 1, includeRejected: true })
    expect(terminalPage.rejected).toHaveLength(1)
    expect((await h.engine.pending({ limit: 1, includeRejected: true, cursor: terminalPage.nextCursor! })).rejected).toEqual([])
    expect(await h.engine.pending({ limit: 1, includeRejected: true, seat: 'other-seat' as T.SeatName })).toMatchObject({ rejected: [] })
    expect(await h.engine.pending({ limit: 1 })).not.toHaveProperty('rejected')
    const committed = h.engine.journal.projection.decisions.map(frame => frame.digest)
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.pending({ limit: 10, includeRejected: true })).toMatchObject({
      items: [], rejected: [{ item: { queueItemId: pending.queueItemId } }],
    })
    expect(restarted.journal.projection.decisions.slice(0, committed.length).map(frame => frame.digest)).toEqual(committed)
    const recovered = restarted.journal.projection.decisions.map(frame => frame.digest)
    await restarted.pending({ limit: 10 })
    expect(restarted.journal.projection.decisions.map(frame => frame.digest)).toEqual(recovered)
  } finally { clock.mockRestore(); await h.close() }
})

test.each(['unregistered', 'ambiguous'] as const)('bounds %s frozen retention with one stable rejected callback at 900000 ms', async (kind) => {
  const { h, input, authorize } = await setup(), clock = vi.spyOn(Date, 'now')
  try {
    h.engine.registerLocalAccess(executionAccess(h))
    if (kind === 'ambiguous') {
      for (const limitMs of [60000, 1800000]) h.engine.registerPreopenRetention({
        sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs })
    }
    const receipt = await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    const chain = pending.frozenOpen!.nodeWorkChain!
    const query = { key: chain.operationKey, payloadDigest: chain.payloadDigest }
    const originalFrames = h.engine.journal.projection.authorizationDecisions.map(frame => frame.digest)
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    const first = h.engine.journal.projection.decisions.find(frame => frame.effects.some(effect => effect.kind === 'queue/pending'))!
    expect(since).toBe(Date.parse(first.observedAt))
    const blocked = structuredClone(h.engine.journal.projection.pending.get(pending.queueItemId)!)
    expect(blocked).toMatchObject({ reason: 'provider-unavailable', blockedBy: ['provider-unavailable'],
      sources: pending.sources, frozenOpen: pending.frozenOpen, queuedAt: pending.queuedAt })
    expect(await h.engine.nodeStatus()).toMatchObject({ engine: 'unavailable' })
    for (const elapsed of [60000, 899999]) {
      clock.mockReturnValue(since + elapsed)
      await h.engine.drive()
      expect(h.engine.journal.projection.pending.get(pending.queueItemId)).toEqual(blocked)
      expect(h.engine.journal.projection.callbacks.size).toBe(0)
      expect(h.engine.journal.projection.opens.size).toBe(0)
      expect(h.creates).toHaveLength(0)
    }
    clock.mockReturnValue(since + 900000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    const terminal = h.engine.journal.projection.decisions.findLast(frame => frame.effects.some(effect => effect.kind === 'queue/cancelled'))!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['open/rejected', 'queue/cancelled', 'callback/pending'])
    const callbackId = digest(['seat-preopen-rejected/v1', nodeId, chain.operationKey,
      pending.queueItemId, sourceId, input.envelope.triggerId])
    expect(terminal.effects[2]).toMatchObject({ causedBy: terminal.effects[1]!.eventId, data: { payload: {
      callbackId, kind: 'rejected', sessionId: null, reason: { code: 'gate-denied',
        message: 'Pre-open retention limit reached', retryable: false, effectState: 'none' } }, nodeWorkChain: { route: input.route } } })
    expect(queryFrozenExecution(h.engine.journal.projection, query)).toMatchObject({ status: 'settled',
      result: { status: 'rejected', error: { code: 'gate-denied' } } })
    expect(await h.engine.acceptFrozen(input, await authorize())).toEqual(receipt)
    await h.engine.drive()
    await h.engine.shutdown()
    const restarted = await h.start()
    await restarted.drive()
    expect(restarted.journal.projection.decisions.flatMap(frame => frame.effects)
      .filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
    expect([...restarted.journal.projection.callbacks.keys()]).toEqual([callbackId])
    expect(restarted.journal.projection.authorizationDecisions.slice(0, originalFrames.length).map(frame => frame.digest))
      .toEqual(originalFrames)
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await h.close() }
})

test('keeps the first fallback retention frame across approval and an engine restart without providers', async () => {
  const { h, pending, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now'), ctx = new Context()
  let restarted: SeatEngine | undefined
  try {
    await removeRetention()
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    await approveForExecution(h, h.engine.journal.projection.pending.get(pending.queueItemId)!)
    clock.mockReturnValue(since + 899999)
    await h.engine.drive()
    const history = h.engine.journal.projection.authorizationDecisions.map(frame => frame.digest)
    await h.engine.shutdown()
    restarted = new SeatEngine(ctx, h.engine.options, { seats: () => undefined, ledger: () => undefined })
    await restarted.ready()
    expect(retentionSince(restarted.journal.projection, pending.queueItemId)).toBe(since)
    await restarted.drive()
    expect(restarted.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    expect(restarted.journal.projection.approved.has(pending.queueItemId)).toBe(true)
    clock.mockReturnValue(since + 900000)
    await restarted.drive()
    expect(restarted.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    expect(restarted.journal.projection.callbacks.size).toBe(1)
    expect(restarted.journal.projection.authorizationDecisions.slice(0, history.length).map(frame => frame.digest)).toEqual(history)
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await restarted?.shutdown(); await ctx.fiber.dispose(); await h.close() }
})

test.each([60000, 1800000])('keeps the registered %s ms limit independent of the fallback', async (limitMs) => {
  const { h, pending, input, recheck, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    h.engine.registerPreopenRetention({ sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs })
    recheck.mockResolvedValue({ status: 'rejected', error: { ...preopenCancelledReason(), retryable: true } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    clock.mockReturnValue(since + limitMs - 1)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    clock.mockReturnValue(since + limitMs)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    expect([...h.engine.journal.projection.callbacks.values()]).toMatchObject([
      { payload: { kind: 'rejected', reason: { code: 'gate-denied', retryable: false, effectState: 'none' } } } ])
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await h.close() }
})

test.each(['before-dispatch', 'during-recheck'] as const)('never opens an approved unregistered route after withdrawal %s', async (stage) => {
  const { h, pending, recheck, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await approveForExecution(h, pending)
    if (stage === 'before-dispatch') await removeRetention()
    else recheck.mockImplementation(async () => { void removeRetention(); return null })
    await h.engine.drive()
    expect(recheck).toHaveBeenCalledTimes(stage === 'before-dispatch' ? 0 : 1)
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    for (const elapsed of [0, 1, 60000, 899999]) {
      clock.mockReturnValue(since + elapsed)
      await h.engine.drive()
      expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.blockedBy).toEqual(['provider-unavailable'])
      expect(h.engine.journal.projection.opens.size).toBe(0)
      expect(h.engine.journal.projection.resources.size).toBe(0)
      expect(h.creates).toHaveLength(0)
    }
    clock.mockReturnValue(since + 900000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
  } finally { clock.mockRestore(); await h.close() }
})

test.each([false, true])('expires route-wide retention without a matching project registration (other project: %s)', async (otherProject) => {
  const { h, pending, input, recheck, query, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    const registration = { sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 }
    h.engine.registerPreopenRetention(registration)
    if (otherProject) h.engine.registerPreopenRetention({ ...registration, projectId: 'another-project' as T.SeatProjectId, limitMs: 1 })
    recheck.mockResolvedValue({ status: 'rejected', error: { ...preopenCancelledReason(), retryable: true } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    expect(Number.isFinite(since)).toBe(true)
    clock.mockReturnValue(since + 999)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)).toMatchObject({
      reason: 'provider-unavailable', blockedBy: ['provider-unavailable'], sources: pending.sources, frozenOpen: pending.frozenOpen,
    })
    clock.mockReturnValue(since + 1000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    const terminal = h.engine.journal.projection.decisions.findLast(frame => frame.effects.some(effect => effect.kind === 'queue/cancelled'))!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['open/rejected', 'queue/cancelled', 'callback/pending'])
    expect(terminal.effects[2]).toMatchObject({ data: { payload: { kind: 'rejected', sessionId: null,
      reason: { code: 'gate-denied', retryable: false, effectState: 'none' } }, nodeWorkChain: { route: input.route } } })
    expect(queryFrozenExecution(h.engine.journal.projection, query)).toMatchObject({ status: 'settled',
      result: { status: 'rejected', error: { code: 'gate-denied' } } })
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await h.close() }
})

test.each([1000, 3000])('uses the exact project limit %s before route-wide retention', async (limitMs) => {
  const { h, pending, input, recheck, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    const registration = { sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 2000 }
    h.engine.registerPreopenRetention(registration)
    const removeExact = h.engine.registerPreopenRetention({ ...registration, projectId: pending.projectId, limitMs })
    recheck.mockResolvedValue({ status: 'rejected', error: { ...preopenCancelledReason(), retryable: true } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    clock.mockReturnValue(since + limitMs - 1)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    clock.mockReturnValue(since + limitMs)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    await removeExact()
    expect(await h.engine.nodeStatus()).toMatchObject({ engine: 'running' })
  } finally { clock.mockRestore(); await h.close() }
})

test.each(['route', 'route-with-exact', 'project'] as const)('keeps ambiguous %s retention queued until the fallback limit', async (kind) => {
  const { h, pending, input, recheck, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    const registration = { sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 }
    h.engine.registerPreopenRetention(registration)
    if (kind !== 'route') h.engine.registerPreopenRetention({ ...registration, projectId: pending.projectId })
    h.engine.registerPreopenRetention({ ...registration,
      ...(kind === 'project' ? { projectId: pending.projectId } : {}) })
    recheck.mockResolvedValue({ status: 'rejected', error: { ...preopenCancelledReason(), retryable: true } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    clock.mockReturnValue(since + 1000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.blockedBy).toEqual(['provider-unavailable'])
    expect(h.engine.journal.projection.callbacks.size).toBe(0)
    expect(h.creates).toHaveLength(0)
    clock.mockReturnValue(since + 899999)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    clock.mockReturnValue(since + 900000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
    const terminal = h.engine.journal.projection.decisions.findLast(frame => frame.effects.some(effect => effect.kind === 'queue/cancelled'))!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['open/rejected', 'queue/cancelled', 'callback/pending'])
    expect(terminal.effects[2]).toMatchObject({ data: { payload: { kind: 'rejected',
      reason: { code: 'gate-denied', retryable: false, effectState: 'none' } } } })
  } finally { clock.mockRestore(); await h.close() }
})

test.each(['source', 'owner'] as const)('does not apply route-wide retention to another %s', async (different) => {
  const { h, pending, input, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    const registration = { sourceId: input.route.sourceId, sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 }
    h.engine.registerPreopenRetention({ ...registration,
      ...(different === 'source' ? { sourceId: 'another-source' as T.SeatSourceId }
        : { sourceOwnerNodeId: 'another-owner' as T.SeatNodeId }) })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    clock.mockReturnValue(since + 1000)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.blockedBy).toEqual(['provider-unavailable'])
    expect(h.engine.journal.projection.callbacks.size).toBe(0)
    expect(h.creates).toHaveLength(0)
    h.engine.registerPreopenRetention(registration)
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
  } finally { clock.mockRestore(); await h.close() }
})

test.each(['project-off', 'approval', 'budget-full', 'budget-unverifiable', 'node-capacity', 'seat-capacity'] as const)(
  'does not turn ordinary %s pending into an expiring provider failure without an executor', async (reason) => {
    const { h, pending, input } = await admitForExecution('remote-source')
    const ctx = new Context(), clock = vi.spyOn(Date, 'now')
    let restarted: SeatEngine | undefined
    try {
      await h.engine.journal.commit(() => [fact({ kind: 'queue/pending', data: { ...pending, reason,
        blockedBy: [], stateVersion: pending.stateVersion + 1 } })])
      await h.engine.shutdown()
      restarted = new SeatEngine(ctx, h.engine.options, { seats: () => undefined, ledger: () => undefined })
      await restarted.ready()
      restarted.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
        sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1 })
      const original = structuredClone(restarted.journal.projection.pending.get(pending.queueItemId))
      await restarted.drive()
      clock.mockReturnValue(Date.now() + 10000)
      await restarted.drive()
      expect(restarted.journal.projection.pending.get(pending.queueItemId)).toEqual(original)
      expect(restarted.journal.projection.callbacks.size).toBe(0)
    } finally { clock.mockRestore(); await restarted?.shutdown(); await ctx.fiber.dispose(); await h.close() }
  })

test('retains frozen input through restart and requires current approval after policy recovery', async () => {
  const { h, pending, input, recheck } = await admitForExecution('remote-source')
  try {
    recheck.mockResolvedValue({ status: 'rejected', error: { code: 'unavailable', message: 'Not ready',
      alternative: 'Retry', retryable: true, effectState: 'none' } })
    await h.engine.drive()
    const blocked = structuredClone(h.engine.journal.projection.pending.get(pending.queueItemId)!)
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)
    await h.engine.shutdown()
    const restarted = await h.start()
    restarted.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 900000 })
    const ready = vi.fn(async (): Promise<T.SeatRejected | null> => null)
    restarted.registerLocalAccess(executionAccess(h, ready))
    expect(retentionSince(restarted.journal.projection, pending.queueItemId)).toBe(since)
    await restarted.drive()
    const current = restarted.journal.projection.pending.get(pending.queueItemId)!
    expect(current).toMatchObject({ reason: 'approval', frozenOpen: blocked.frozenOpen, sources: blocked.sources,
      queuedAt: blocked.queuedAt, stateVersion: blocked.stateVersion + 1 })
    expect(h.creates).toHaveLength(0)
    expect(await restarted.approve({ queueItemId: pending.queueItemId, expectedStateVersion: blocked.stateVersion,
      operationId: 'stale-approval' as T.SeatOperationId })).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    await restarted.approve({ queueItemId: pending.queueItemId, expectedStateVersion: current.stateVersion,
      operationId: 'current-approval' as T.SeatOperationId })
    await restarted.drive()
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test('keeps ordinary remind and switched-off queues out of automatic terminal cancellation', async () => {
  const { h, pending, recheck } = await admitForExecution('remote-source')
  try {
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.reason).toBe('approval')
    await h.engine.setProjectMode({ projectId: pending.projectId, mode: 'off', expectedRevision: 0,
      operationId: 'turn-off' as T.SeatOperationId })
    recheck.mockResolvedValue({ status: 'rejected', error: { code: 'gate-denied', message: 'Denied',
      alternative: 'Retry', retryable: false, effectState: 'none' } })
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.reason).toBe('project-off')
    expect(h.engine.journal.projection.callbacks.size).toBe(0)
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test('starts a new retention segment only on a changed category and does not expire on a backward clock', async () => {
  const { h, pending, recheck, input, removeRetention } = await admitForExecution('remote-source')
  const clock = vi.spyOn(Date, 'now')
  try {
    await removeRetention()
    h.engine.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1000 })
    recheck.mockResolvedValue({ status: 'rejected', error: { code: 'unavailable', message: 'Not ready',
      alternative: 'Retry', retryable: true, effectState: 'unknown' } })
    await h.engine.drive()
    const since = retentionSince(h.engine.journal.projection, pending.queueItemId)!
    clock.mockReturnValue(since - 10000)
    await h.engine.drive()
    expect(retentionSince(h.engine.journal.projection, pending.queueItemId)).toBe(since)
    recheck.mockResolvedValue({ status: 'rejected', error: { code: 'gate-denied', message: 'Not ready',
      alternative: 'Retry', retryable: true, effectState: 'none', cause: { domain: 'test-policy', code: 'scope-conflict',
        reason: 'Unavailable', retryable: true, effectState: 'none', operationId: input.route.originalOperationId, nodeId } } })
    await h.engine.drive()
    const frame = h.engine.journal.projection.decisions.at(-1)!
    expect(retentionSince(h.engine.journal.projection, pending.queueItemId)).toBe(Date.parse(frame.observedAt))
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.blockedBy).toEqual(['scope-conflict'])
    const version = h.engine.journal.projection.pending.get(pending.queueItemId)!.stateVersion
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.stateVersion).toBe(version)
    expect(h.creates).toHaveLength(0)
  } finally { clock.mockRestore(); await h.close() }
})

test('withdraws ambiguous retention registrations without inheriting permission from another instance', async () => {
  const { h, pending, input, removeRetention } = await admitForExecution('remote-source')
  try {
    const removeDuplicate = h.engine.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 1 })
    await approveForExecution(h, pending)
    await h.engine.drive()
    expect(h.creates).toHaveLength(0)
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)?.blockedBy).toEqual(['provider-unavailable'])
    await removeDuplicate()
    await removeRetention()
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
    h.engine.registerPreopenRetention({ projectId: pending.projectId, sourceId: input.route.sourceId,
      sourceOwnerNodeId: input.route.sourceOwnerNodeId, limitMs: 900000 })
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test.each(['automatic', 'reserve', 'legacy', 'authorized'] as const)('recovers one rejected callback for old %s cancellation without rewriting history', async (kind) => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    const cancelId = 'historical-cancel' as T.SeatOperationId
    const grant = kind === 'authorized' ? (await authorize()).authorization.fact : undefined
    await h.engine.shutdown()
    const journal = new EngineJournal(h.engine.journal.root, nodeId, h.engine.journal.maxBytes)
    await journal.ready()
    try {
      await journal.commitAuthorization(() => {
        const error: T.SeatFailure = { code: kind === 'reserve' ? 'seat-already-open' : 'gate-denied',
          message: 'Historical refusal', alternative: 'Inspect original operation', retryable: true, effectState: 'none' }
        const cancelled = fact({ kind: 'queue/cancelled', ...(kind === 'legacy' || grant ? { operationId: cancelId } : {}), data: {
          pending, principalId: grant?.principalId ?? 'engine-policy' as T.SeatPrincipalId,
          previousRevision: pending.stateVersion, revision: pending.stateVersion + 1,
          ...(grant ? { cancellation: { authorizationId: grant.authorizationId, principalId: grant.principalId, kind: grant.kind,
            operationId: cancelId, queueItemId: pending.queueItemId, cancelledAt: new Date().toISOString(),
            stateVersion: pending.stateVersion + 1, reasonPresent: false } } : {}) } })
        return [...(kind === 'automatic' || kind === 'reserve' ? [fact({ kind: 'open/rejected', seat: pending.seat,
          data: { error, candidates: [] } })] : []), cancelled,
        ...(grant ? [authorizationEffect({ ...grant, operationId: cancelId })] : [])]
      })
    } finally { await journal.close() }
    const before = journal.projection.authorizationDecisions.map(frame => frame.digest)
    const restarted = await h.start()
    const callbacks = restarted.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending')
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]!.data.payload).toMatchObject({ kind: 'rejected', sessionId: null,
      reason: { effectState: 'none', retryable: kind === 'automatic' || kind === 'reserve' } })
    const terminal = restarted.journal.projection.decisions.flatMap(frame => frame.effects).find(effect => effect.kind === 'queue/cancelled')!
    expect(callbacks[0]!.causedBy).toBe(terminal.eventId)
    expect(restarted.journal.projection.authorizationDecisions.slice(0, before.length).map(frame => frame.digest)).toEqual(before)
    await restarted.shutdown()
    const again = await h.start()
    expect(again.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
    expect(again.journal.projection.pending.size).toBe(0)
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test.each(['oversized-notification', 'corrupt-history'] as const)('refuses readiness on pre-open recovery %s without changing old frames', async (kind) => {
  const { h, input, authorize } = await setup()
  const ctx = new Context()
  let restarted: SeatEngine | undefined
  let ready = 0
  ctx.on('seat/ready', () => { ready++ })
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.journal.commit(() => [fact({ kind: 'queue/cancelled', operationId: 'old-terminal' as T.SeatOperationId,
      data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId,
        previousRevision: pending.stateVersion, revision: pending.stateVersion + 1 } })])
    await h.engine.shutdown()
    const events = join(h.engine.journal.root, 'events'), names = await readdir(events)
    const bytes = await Promise.all(names.map(name => readFile(join(events, name))))
    if (kind === 'corrupt-history') await writeFile(join(events, '9999999999999999-corrupt.jsonl'), '{"sequence":3}\n')
    restarted = new SeatEngine(ctx, { ...h.engine.options, config: { ...h.engine.options.config,
      nodeName: kind === 'oversized-notification' ? 'n'.repeat(h.engine.journal.maxBytes) : 'node-a' } }, {
      seats: () => undefined, ledger: () => undefined,
    })
    await expect(restarted.ready()).rejects.toMatchObject({
      code: kind === 'oversized-notification' ? 'source-payload-too-large' : 'engine-store-corrupt',
    })
    expect(ready).toBe(0)
    expect(restarted.journal.projection.callbacks.size).toBe(0)
    expect(await Promise.all(names.map(name => readFile(join(events, name))))).toEqual(bytes)
    expect((await readdir(events)).length).toBe(names.length + (kind === 'corrupt-history' ? 1 : 0))
    expect(h.creates).toHaveLength(0)
  } finally { await restarted?.shutdown(); await ctx.fiber.dispose(); await h.close() }
})

test('keeps authorized cancellation audit text out of the rejected callback and replays its receipt', async () => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    const request: T.CancelPendingSeatRequest = { queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'audited-terminal' as T.SeatOperationId, reason: 'Operator-only cancellation detail' }
    const issuer = h.engine.authorizationIssuers.register({ identity: { kind: 'local-operator',
      principalId: 'operator' as T.SeatPrincipalId, nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const grant = await issuer.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
    if ('status' in grant) throw new Error('Expected grant')
    const first = await h.engine.authorizations.cancel(request, grant)
    expect(first).toMatchObject({ status: 'cancelled', stateVersion: pending.stateVersion + 1 })
    const frame = h.engine.journal.projection.authorizationDecisions.at(-1)!
    expect(frame.effects.map(effect => effect.kind)).toEqual(['queue/cancelled', 'callback/pending', 'authorization/checked'])
    const callback = frame.effects.find(effect => effect.kind === 'callback/pending')!
    expect(JSON.stringify(callback)).not.toContain(request.reason)
    expect(callback).toMatchObject({ data: { payload: { reason: preopenCancelledReason() } } })
    expect(await h.engine.authorizations.operation({ operationId: request.operationId })).toMatchObject({ status: 'settled',
      result: { status: 'cancelled', cancellation: { reason: request.reason, stateVersion: pending.stateVersion + 1 } } })
    expect(await h.engine.authorizations.cancel(request, grant)).toEqual(first)
    expect(h.engine.journal.projection.authorizationDecisions.at(-1)).toBe(frame)
  } finally { await h.close() }
})

test('invalidates an in-flight permanent refusal after manual cancellation wins the queue CAS', async () => {
  const { h, pending, recheck } = await admitForExecution('remote-source')
  try {
    recheck.mockImplementation(async () => {
      await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
        operationId: 'racing-cancel' as T.SeatOperationId })
      return { status: 'rejected', error: preopenCancelledReason() }
    })
    await h.engine.drive()
    const effects = h.engine.journal.projection.decisions.flatMap(frame => frame.effects)
    expect(effects.filter(effect => effect.kind === 'queue/cancelled')).toHaveLength(1)
    expect(effects.filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test('uses the current frozen queue version and keeps its proven terminal ahead of transport uncertainty', async () => {
  const { h, pending, input, recheck } = await admitForExecution('remote-source')
  try {
    recheck.mockResolvedValue({ status: 'rejected', error: { ...preopenCancelledReason(), retryable: true } })
    await h.engine.drive()
    const current = h.engine.journal.projection.pending.get(pending.queueItemId)!
    expect(await h.engine.authorizations.operation({ operationId: input.route.originalOperationId }))
      .toMatchObject({ status: 'pending', stateVersion: current.stateVersion })
    await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: current.stateVersion,
      operationId: 'cancel-unknown-transport' as T.SeatOperationId })
    const delivery = [...h.engine.journal.projection.callbacks.values()][0]!
    await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...delivery, responseClass: 'unknown' } })])
    expect(await h.engine.authorizations.operation({ operationId: input.route.originalOperationId }))
      .toMatchObject({ status: 'settled', result: { status: 'rejected', error: { code: 'gate-denied' } } })
  } finally { await h.close() }
})

test('retains the complete queue when its cancellation frame exceeds the byte limit', async () => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.shutdown()
    const effects = withPreopenCallbacks(h.engine.journal.projection, [fact({ kind: 'queue/cancelled', operationId: 'small-frame' as T.SeatOperationId,
      data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId, previousRevision: pending.stateVersion,
        revision: pending.stateVersion + 1 } })], preopenCancelledReason(), 'node-a')
    const original = structuredClone(pending)
    const write = new EngineJournal(h.engine.journal.root, nodeId, h.engine.journal.maxBytes)
    await write.ready()
    try {
      const oversized = [...effects, ...Array.from({ length: write.maxBytes / 100 }, () => fact({ kind: 'open/rejected', seat,
        data: { error: preopenCancelledReason(), candidates: [] } }))]
      await expect(write.commit(() => oversized)).rejects.toThrow('Complete engine decision exceeds its byte limit')
      expect(write.projection.pending.get(pending.queueItemId)).toEqual(original)
      expect(write.projection.callbacks.size).toBe(0)
    } finally { await write.close() }
  } finally { await h.close() }
})

test('refuses a reused pre-open callback identity with a changed digest without cancelling its queue', async () => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!, item = frozenItems(h.engine.journal.projection)[0]!
    const cancellation = fact({ kind: 'queue/cancelled', operationId: 'conflicting-cancel' as T.SeatOperationId,
      data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId, previousRevision: pending.stateVersion, revision: pending.stateVersion + 1 } })
    if (cancellation.kind !== 'queue/cancelled') throw new Error('Expected cancellation')
    await h.engine.journal.commit(view => preopenCallback(view, item, cancellation,
      { ...preopenCancelledReason(), message: 'Another safe reason' }, 'node-a', new Date().toISOString()))
    await expect(h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'real-cancel' as T.SeatOperationId })).rejects.toThrow('Pre-open callback identity conflicts')
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)).toEqual(pending)
  } finally { await h.close() }
})

test.each(['callback', 'ambiguous-reason', 'bad-version'] as const)('does not repair historical %s evidence', async (kind) => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!, item = frozenItems(h.engine.journal.projection)[0]!
    const cancellation = fact({ kind: 'queue/cancelled', operationId: 'historical-negative' as T.SeatOperationId,
      data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId, previousRevision: pending.stateVersion,
        revision: pending.stateVersion + (kind === 'bad-version' ? 2 : 1) } })
    if (cancellation.kind !== 'queue/cancelled') throw new Error('Expected cancellation')
    await h.engine.journal.commit(view => [cancellation,
      ...(kind === 'callback' ? preopenCallback(view, item, cancellation, preopenCancelledReason(), 'node-a', new Date().toISOString()) : []),
      ...(kind === 'ambiguous-reason' ? [fact({ kind: 'open/rejected', seat, data: { error: preopenCancelledReason(), candidates: [] } }),
        fact({ kind: 'open/rejected', seat, data: { error: preopenCancelledReason(), candidates: [] } })] : [])])
    const before = h.engine.journal.projection.sequence
    await recoverPreopenCallbacks(h.engine.journal, 'node-a')
    await recoverPreopenCallbacks(h.engine.journal, 'node-a')
    expect(h.engine.journal.projection.sequence).toBe(before)
    expect(h.engine.journal.projection.callbacks.size).toBe(kind === 'callback' ? 1 : 0)
  } finally { await h.close() }
})

test('does not repair normal dispatch even after its resource is released', async () => {
  const { h, pending } = await admitForExecution('remote-source')
  try {
    await approveForExecution(h, pending)
    await h.engine.drive()
    const resource = [...h.engine.journal.projection.resources.values()][0]!
    await h.engine.journal.commit(() => [fact({ kind: 'resource/released', data: { owner: resource.owner,
      reason: 'open-aborted', observedAt: new Date().toISOString(), releasedAt: new Date().toISOString(), engineReadyAt: null, fenced: true } })])
    const before = h.engine.journal.projection.sequence
    await recoverPreopenCallbacks(h.engine.journal, 'node-a')
    expect(h.engine.journal.projection.sequence).toBe(before)
    expect(h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending'
      && effect.data.payload.kind === 'rejected')).toHaveLength(0)
  } finally { await h.close() }
})

test('commits a permanent frozen refusal and its original owner notification in one frame', async () => {
  const { h, pending, recheck, input } = await admitForExecution('remote-source')
  try {
    recheck.mockResolvedValue({ status: 'rejected', error: preopenCancelledReason() })
    await h.engine.drive()
    const terminal = h.engine.journal.projection.decisions.find(frame => frame.effects.some(effect => effect.kind === 'queue/cancelled'))!
    expect(terminal.effects.map(effect => effect.kind)).toEqual(['open/rejected', 'queue/cancelled', 'callback/pending'])
    expect(terminal.effects[2]).toMatchObject({ operationId: input.route.originalOperationId,
      data: { payload: { stateVersion: pending.stateVersion + 1, kind: 'rejected', sessionId: null }, nodeWorkChain: { route: input.route } } })
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test('keeps one stable rejection per original frozen source in a shared historical queue', async () => {
  const { h, input, authorize } = await setup()
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const first = [...h.engine.journal.projection.pending.values()][0]!
    const second = structuredClone(input), operationId = 'second-original' as T.SeatOperationId
    second.envelope = trigger('external', 'second-source')
    second.route = { ...second.route, originalOperationId: operationId, triggerId: second.envelope.triggerId,
      sourceOwnerNodeId: 'second-owner' as T.SeatNodeId }
    second.openingContext.scopeReservation = { ...second.openingContext.scopeReservation, operationId,
      sourceOwnerNodeId: second.route.sourceOwnerNodeId }
    const authority = await authorize(second), chain = frozenIdentity(second, authority, 'engine.acceptFrozen')
    if ('status' in chain) throw new Error('Expected chain')
    const merged = { ...first, sources: [...first.sources, second.envelope], stateVersion: first.stateVersion + 1,
      frozenOpen: { ...first.frozenOpen!, nodeWorkChain: chain } }
    await h.engine.journal.commitAuthorization(() => [fact({ kind: 'trigger/coalesced', seat, operationId,
      triggerId: second.envelope.triggerId, data: { trigger: second.envelope, pending: merged,
        originalTriggerId: first.sources[0]!.triggerId, deduplication: { key: digest(chain.operationKey),
          digest: chain.payloadDigest, receivedAt: second.envelope.receivedAt, bucket: null,
          sourceId, eventId: second.envelope.eventId ?? null } } }),
    { kind: 'node-route/accepted', eventId: fact({ kind: 'queue/pending', data: merged }).eventId,
      operationId, seat, data: chain }, authorizationEffect(authority.authorization.fact)])
    await h.engine.cancel({ queueItemId: first.queueItemId, expectedStateVersion: merged.stateVersion,
      operationId: 'shared-cancel' as T.SeatOperationId })
    const deliveries = [...h.engine.journal.projection.callbacks.values()]
    expect(deliveries).toHaveLength(2)
    expect(new Set(deliveries.map(delivery => delivery.payload.callbackId)).size).toBe(2)
    expect(deliveries.map(delivery => delivery.nodeWorkChain?.route)).toEqual([input.route, second.route])
    const bodies = deliveries.map(delivery => delivery.nodeWorkChain)
    await h.engine.shutdown()
    const restarted = await h.start()
    await recoverPreopenCallbacks(restarted.journal, 'node-a')
    expect([...restarted.journal.projection.callbacks.values()].map(delivery => delivery.nodeWorkChain)).toEqual(bodies)
    for (const item of frozenItems(restarted.journal.projection)) {
      expect(queryFrozenExecution(restarted.journal.projection, { key: item.chain.operationKey, payloadDigest: item.chain.payloadDigest }))
        .toMatchObject({ status: 'settled', result: { status: 'rejected' } })
    }
  } finally { await h.close() }
})

test('replays a rejected original three extra times across restart without another callback or changed digest', async () => {
  const { h, input, authorize } = await setup()
  try {
    const receipt = await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'replay-terminal' as T.SeatOperationId })
    const retained = [...h.engine.journal.projection.callbacks.values()][0]!
    const cancellation = h.engine.journal.projection.decisions.flatMap(frame => frame.effects).find(effect => effect.kind === 'queue/cancelled')!
    if (cancellation.kind !== 'queue/cancelled') throw new Error('Expected cancellation')
    let engine = h.engine
    for (let replay = 0; replay < 3; replay++) {
      if (replay === 1) { await engine.shutdown(); engine = await h.start() }
      const item = frozenItems(engine.journal.projection)[0]!
      expect(await engine.acceptFrozen(input, await authorize(input, engine))).toEqual(receipt)
      expect(await engine.journal.commit(view => preopenCallback(view, item, cancellation,
        preopenCancelledReason(), 'node-a', new Date().toISOString()))).toBeNull()
      expect([...engine.journal.projection.callbacks.values()]).toEqual([retained])
      expect(engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
    }
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test('does not publish half a cancellation when the journal write fails', async () => {
  const { h, input, authorize } = await setup()
  const events = join(h.engine.journal.root, 'events'), retained = join(h.engine.journal.root, 'retained-events')
  let moved = false
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await rename(events, retained); moved = true
    await expect(h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
      operationId: 'failed-write' as T.SeatOperationId })).rejects.toThrow('Engine commit outcome requires recovery')
    expect(h.engine.journal.projection.pending.get(pending.queueItemId)).toEqual(pending)
    expect(h.engine.journal.projection.callbacks.size).toBe(0)
    await rename(retained, events); moved = false
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(restarted.journal.projection.pending.get(pending.queueItemId)).toEqual(pending)
    expect(restarted.journal.projection.callbacks.size).toBe(0)
  } finally { if (moved) await rename(retained, events); await h.close() }
})

test.each(['before-append', 'after-append'] as const)('recovers one pre-open notification after SIGKILL at %s', async (stage) => {
  const { h, input, authorize } = await setup()
  let child: ChildProcess | undefined
  try {
    await h.engine.acceptFrozen(input, await authorize())
    const pending = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.journal.commit(() => [fact({ kind: 'queue/cancelled', operationId: 'old-cancel' as T.SeatOperationId,
      data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId,
        previousRevision: pending.stateVersion, revision: pending.stateVersion + 1 } })])
    await h.engine.shutdown()
    const events = join(h.engine.journal.root, 'events'), names = await readdir(events)
    const bytes = await Promise.all(names.map(name => readFile(join(events, name))))
    child = fork(fileURLToPath(new URL('./preopen-recovery-worker.ts', import.meta.url)), [h.engine.journal.root, stage], {
      execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))) })
    expect(child.pid).toBeTypeOf('number')
    const owned = child, exited = once(owned, 'exit')
    await new Promise<void>((resolve, reject) => {
      owned.on('message', (message) => { if (message && typeof message === 'object' && 'stage' in message && message.stage === stage) resolve() })
      owned.once('error', reject)
      owned.once('exit', () => { reject(new Error('Recovery child exited before barrier')) })
    })
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    expect(owned.exitCode).toBeNull()
    expect(owned.signalCode).toBeNull()
    owned.kill('SIGKILL')
    expect(await exited).toEqual([null, 'SIGKILL'])
    const restarted = await h.start()
    expect([...restarted.journal.projection.callbacks.values()]).toHaveLength(1)
    const body = [...restarted.journal.projection.callbacks.values()][0]!.nodeWorkChain
    await restarted.shutdown()
    const again = await h.start()
    expect([...again.journal.projection.callbacks.values()].map(delivery => delivery.nodeWorkChain)).toEqual([body])
    expect(again.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/pending')).toHaveLength(1)
    expect(await Promise.all(names.map(name => readFile(join(events, name))))).toEqual(bytes)
    expect(h.creates).toHaveLength(0)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    await h.close()
  }
}, 20000)

test('refuses missing sender, forged grants and denied target policies without admission', async () => {
  const { h, input, authorize } = await setup()
  try {
    const valid = await authorize()
    const missing = { ...valid.authorization.fact }
    delete missing.sourceNodeId
    expect(await h.engine.acceptFrozen(input, { ...valid, authorization: { ...valid.authorization, fact: missing } }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(await h.engine.acceptFrozen(input, { ...valid, authorization: { ...valid.authorization } }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    delete h.definitions.get(seat)!.remoteAdmission
    expect(await h.engine.acceptFrozen(input, valid)).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(h.engine.journal.projection.sequence).toBe(0)
  } finally { await h.close() }
})
