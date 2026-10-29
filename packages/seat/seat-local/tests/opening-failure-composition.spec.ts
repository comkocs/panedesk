/** Provider errors settle the original opening without replaying a model turn. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

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
