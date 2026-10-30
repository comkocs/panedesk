/** Provider errors settle the original opening without replaying a model turn. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { createUserMessage, LlmError, type StreamChunk } from '@panedesk/dsh-llm'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { fact } from '@panedesk/dsh-seat-engine/src/triggers.ts'
import { digest } from '@panedesk/dsh-seat-engine/src/journal.ts'
import type { SessionId } from '@panedesk/dsh-session'

it('contains an invalid definition from the real executor and clears its alert after repair', async () => {
  const f = await admissionHost(undefined, { failureRecovery: { retryInitialMs: 1000 }, ownerObserveIntervalMs: 60000 })
  try {
    await f.seats.save({ definition: { ...f.definition, opening: { kind: 'text', text: '{{unsupported}}' } },
      expectedRevision: 2, operationId: operation('invalid-definition') })
    const definition = await f.seats.resolve(f.definition.seat)
    if ('status' in definition) throw new Error('Expected the retained definition')
    const sessionId = 'invalid-window' as SessionId
    const openingOperationId = operation('invalid-open'), openingDigest = digest('retained-template')
    // Recovered intents without frozen text reach the real executor's template renderer.
    const open: T.EngineOpenData = { intentId: 'invalid-intent' as T.OpenIntentId, sessionId,
      seatRevision: definition.revision, phase: 'intent', completedStages: [], openingOperationId,
      openingMessageId: null, openingDigest, definition, title: definition.seat, sources: [], failure: null,
      binding: { kind: 'seat', sessionId, seat: definition.seat, nodeId: f.options.nodeId, projectId: definition.projectId,
        bindingSource: 'seat-definition', identitySource: 'settings', openOperationId: openingOperationId,
        seatRevision: definition.revision, relatedTaskIds: [], directories: definition.directories,
        memoryDirectories: [], subscriptions: [], openingDigest },
      budget: { sessionId, seat: definition.seat, currency: 'USD', costState: 'known', windowCost: '0' as T.MicroUsd,
        dailyCost: '0' as T.MicroUsd, limits: {}, dayKey: new Date().toISOString().slice(0, 10), budgetTimeZone: 'UTC',
        inFlightUnknown: 0, watermark: 0, budgetRevision: 0 } }
    await f.engine.journal.commit(() => [fact({ kind: 'open/intent', sessionId, data: open }),
      fact({ kind: 'resource/reserved', sessionId, seat: definition.seat, data: { nodeId: f.options.nodeId,
        seat: definition.seat, owner: { sessionId, intentId: open.intentId, ownerEpoch: 'invalid-epoch' as T.OwnerEpoch,
          resourceRevision: 1 }, exclusiveTags: [], engineWindowUnits: 1, seatWindowUnits: 1 } })])
    await f.engine.drive()
    expect(f.engine.journal.projection.opens.size).toBe(1)
    expect(f.engine.journal.projection.opens.get(sessionId)).toMatchObject({
      phase: 'opening-failed', failure: { code: 'invalid-definition', effectState: 'none' },
    })
    expect(await f.engine.nodeStatus()).toMatchObject({ engine: 'running', openingFailures: [
      { seat: f.definition.seat, code: 'invalid-definition' },
    ] })
    const healthySeat = 'healthy-seat' as T.SeatName
    await f.seats.save({ definition: { ...f.definition, seat: healthySeat }, expectedRevision: 3,
      operationId: operation('save-independent') })
    expect(await f.seats.open({ seat: healthySeat, origin: 'manual', operationId: operation('independent-open'),
      openingMode: 'prefill' })).toMatchObject({ status: 'prefilled' })
    const changed = vi.fn()
    const stop = f.ctx.on('seat/diagnostics-changed', changed)
    await f.seats.save({ definition: f.definition, expectedRevision: 4, operationId: operation('repair-definition') })
    expect(changed).toHaveBeenCalledOnce()
    stop()
    expect((await f.engine.nodeStatus()).openingFailures).toBeUndefined()
    expect(await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('repaired-open'),
      openingMode: 'prefill' })).toMatchObject({ status: 'prefilled' })
    expect(await f.engine.nodeStatus()).toMatchObject({ engine: 'running' })
    expect((await f.engine.nodeStatus()).openingFailures).toBeUndefined()
  } finally { await f.close() }
}, 15000)

it.each(['UNKNOWN_MODEL', 'session/model-unavailable'] as const)('reports a live window model failure without stopping other seats: %s', async (code) => {
  const f = await admissionHost(undefined, { ownerObserveIntervalMs: 60000 })
  const stream = f.adapter.stream.bind(f.adapter)
  const resolve = f.adapter.resolveModel.bind(f.adapter)
  let unavailable = false
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('live-model'),
      openingMode: 'prefill' })
    expect(opened.status).toBe('prefilled')
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled seat')
    const agent = f.ctx.agents.get(opened.sessionId)!
    const healthySeat = 'healthy-seat' as T.SeatName
    await f.seats.save({ definition: { ...f.definition, seat: healthySeat }, expectedRevision: 2,
      operationId: operation('save-healthy') })
    const healthy = await f.seats.open({ seat: healthySeat, origin: 'manual', operationId: operation('healthy-model'),
      openingMode: 'prefill' })
    if (healthy.status !== 'prefilled') throw new Error('Expected another prefilled seat')
    f.adapter.listModels = provider => Promise.resolve(['model-a', 'live-model'].map(id => ({ provider, id, name: id })))
    await f.ctx.sessionController.selectModel({ sessionId: agent.id, provider: 'provider-a', model: 'live-model' })
    const failure = () => code === 'UNKNOWN_MODEL' ? new LlmError('Model removed', 'UNKNOWN_MODEL')
      : Object.assign(new Error('Model removed'), { isDSHRemoteError: true, code,
        details: { provider: 'provider-a', model: 'live-model' } })
    f.adapter.resolveModel = async (provider, model) => {
      if (unavailable && model === 'live-model') throw failure()
      return resolve(provider, model)
    }
    f.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (unavailable && options.model === 'live-model') throw failure()
      yield* stream(options)
    }
    unavailable = true
    await f.engine.admitTurn(agent.id)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the selected model.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const failedSnapshot = await f.ctx.sessionQuery.readSession(agent.id)
    expect(failedSnapshot.events.filter(event => event.type === 'turn/end').at(-1)).toMatchObject({
      data: { reason: { kind: 'error', error: { code: code === 'UNKNOWN_MODEL' ? code : 'UNKNOWN', message: 'Model removed' } } },
    })
    const status = await f.engine.nodeStatus()
    expect(status.engine).toBe('running')
    expect(status.openingFailures).toEqual([expect.objectContaining({ sessionId: agent.id, seat: f.definition.seat,
      provider: 'provider-a', model: 'live-model' })])
    const other = f.ctx.agents.get(healthy.sessionId)!
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue independently.' }], source: { kind: 'user' } }))
    await other.whenIdle()
    const otherSnapshot = await f.ctx.sessionQuery.readSession(other.id)
    expect(otherSnapshot.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
    unavailable = false
    await f.engine.admitTurn(agent.id)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resend after restoring the model.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect((await f.engine.nodeStatus()).openingFailures ?? []).toEqual([])
    expect((await f.engine.nodeStatus()).engine).toBe('running')
  } finally { await f.close() }
}, 15000)

it('excludes absent failed openings from dispatchable windows after reload', async () => {
  const f = await admissionHost(undefined, { ownerObserveIntervalMs: 60000 })
  const create = vi.spyOn(f.ctx.agents, 'create').mockRejectedValueOnce(Object.assign(new Error('Missing preset'), {
    name: 'RemoteError', code: 'agent-preset/not-found', isDSHRemoteError: true,
  }))
  try {
    const result = await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('missing-preset') })
    expect(result).toMatchObject({ status: 'rejected', error: { effectState: 'none' } })
    const failed = [...f.engine.journal.projection.opens.values()][0]!
    expect(failed.phase).toBe('opening-failed')
    create.mockRestore()
    const seats = await f.reload()
    const listed = await seats.list({})
    expect(listed).toMatchObject({ status: 'listed', sessions: [], unopenedSeats: [f.definition.seat] })
    if (!seats.messageWindows) throw new Error('Message window capability is missing')
    expect(await seats.messageWindows()).toEqual([])
    expect(f.engine.journal.projection.opens.has(failed.sessionId)).toBe(true)
    expect((await f.engine.nodeStatus()).openingFailures).toEqual([{ sessionId: failed.sessionId,
      seat: f.definition.seat, agentPreset: f.definition.agentPreset, code: 'open-create-failed' }])
    expect(f.engine.journal.projection.opens.get(failed.sessionId)?.failure?.details).toEqual({ agentPreset: f.definition.agentPreset })
    const healthy = await seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('restored-preset'),
      openingMode: 'prefill' })
    expect(healthy.status).toBe('prefilled')
    expect((await f.engine.nodeStatus()).openingFailures).toBeUndefined()
    expect(f.engine.journal.projection.opens.has(failed.sessionId)).toBe(true)
  } finally { create.mockRestore(); await f.close() }
}, 15000)

it('records a failed opening and callback after an actual provider error turn', async () => {
  const f = await admissionHost()
  const callbacks: T.SeatCallbackPayload[] = []
  const sourceId = 'failure-source' as T.SeatSourceId
  let calls = 0
  f.adapter.stream = async function* (): AsyncIterable<StreamChunk> {
    calls++
    throw new Error('provider-first-turn-failed')
  }
  const dispose = f.engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null,
    callback: async (payload) => { callbacks.push(payload) } })
  try {
    await f.seats.save({ definition: { ...f.definition, rules: [{ id: 'failure-rule' as T.SeatRuleId,
      enabled: true, trigger: { kind: 'external', sourceId }, timeWindows: [], exclusiveTags: [] }] },
    expectedRevision: 2, operationId: operation('failure-definition') })
    await f.engine.setProjectMode({ projectId: f.definition.projectId, mode: 'auto', expectedRevision: 0,
      operationId: operation('failure-auto') })
    await f.engine.accept({ triggerId: 'failure-trigger' as T.TriggerId, eventId: 'failure-event' as T.SourceEventId,
      sourceId, callbackRef: sourceId, kind: 'external', evidence: { kind: 'external', eventType: 'failure' },
      seat: f.definition.seat, projectId: f.definition.projectId, receivedAt: new Date().toISOString(), data: null,
      dataDigest: 'failure-digest' as T.SeatDigest })
    await vi.waitFor(async () => {
      await f.engine.drive()
      expect(callbacks.some(payload => payload.kind === 'opening-failed')).toBe(true)
    }, { timeout: 10000 })
    const opened = [...f.engine.journal.projection.opens.values()][0]!
    expect(opened.phase).toBe('opening-failed')
    const snapshot = await f.ctx.sessionQuery.readSession(opened.sessionId)
    expect(snapshot.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
    expect(callbacks.find(payload => payload.kind === 'opening-failed')).toMatchObject({
      reason: { code: 'opening-failed' }, sessionId: opened.sessionId })
    for (let i = 0; i < 3; i++) await f.engine.drive()
    expect(calls).toBe(1)
    expect(callbacks.filter(payload => payload.kind === 'opening-failed')).toHaveLength(1)
  } finally { await dispose(); await f.close() }
}, 15000)
