import { afterEach, describe, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, projectId, seat, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() { const h = await harness(); cleanups.push(h.close); return h }
describe('durable trigger admission', () => {
  it.each(['source-not-found', 'unauthorized'] as const)('audits %s without admitting business work', async (code) => {
    const h = await setup()
    const envelope = trigger()
    if (code === 'source-not-found') envelope.sourceId = 'unregistered-a' as T.SeatSourceId
    else envelope.callbackRef = 'other-a' as T.SeatSourceId
    expect(await h.engine.accept(envelope)).toMatchObject({ status: 'rejected', error: { code } })
    expect(h.engine.journal.projection.pending.size).toBe(0)
    expect(h.engine.journal.projection.dedup.size).toBe(0)
    expect(h.engine.journal.projection.decisions.flatMap(item => item.effects)).toMatchObject([
      { kind: 'source/rejected', data: { sourceId: envelope.sourceId, sourceEventId: envelope.eventId, error: { code } } },
    ])
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(restarted.journal.projection.decisions.flatMap(item => item.effects)).toMatchObject([
      { kind: 'source/rejected', data: { error: { code } } },
    ])
    expect(h.creates).toEqual([])
  })
  it.each(['schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual'] as const)('A08 routes %s through each project mode', async (kind) => {
    for (const mode of ['off', 'remind', 'auto'] as const) {
      const h = await setup()
      await h.engine.setProjectMode({ projectId, mode, expectedRevision: 0, operationId: 'mode-a' as T.SeatOperationId })
      const result = await h.engine.accept(trigger(kind))
      await h.engine.drive()
      const executes = mode === 'auto' || kind === 'manual'
      expect(h.creates.length).toBe(executes && kind !== 'handoff-timeout' ? 1 : 0)
      expect(h.wakes.map(wake => wake.senderSessionId)).toEqual(executes && kind === 'handoff-timeout' ? ['sender-a'] : [])
      expect(result.status).toBe(mode === 'off' && kind !== 'manual' ? 'rejected' : 'accepted')
    }
  })
  it('A11 defaults to remind and requires approval without allowing rule widening', async () => {
    const h = await setup()
    expect(await h.engine.projectPolicy(projectId)).toEqual({ projectId, mode: 'remind', modeChosen: false, revision: 0 })
    h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: trigger().sourceId }, mode: 'auto', timeWindows: [], exclusiveTags: [] }]
    await h.engine.accept(trigger()); await h.engine.drive()
    expect(h.creates).toEqual([])
    const [pending] = (await h.engine.pending({ limit: 10 })).items
    expect(pending?.reason).toBe('approval')
    await h.engine.approve({ queueItemId: pending!.queueItemId, expectedStateVersion: pending!.stateVersion, operationId: 'approve-a' as T.SeatOperationId })
    await h.engine.drive(); expect(h.creates).toHaveLength(1)
  })
  it('A11 rechecks tightening and pauses rather than deleting queued work', async () => {
    const h = await setup(); await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.setProjectMode({ projectId, mode: 'off', expectedRevision: 1, operationId: 'off-a' as T.SeatOperationId })
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect((await h.engine.pending({ limit: 10 })).items[0]?.reason).toBe('project-off')
    await h.engine.setProjectMode({ projectId, mode: 'auto', expectedRevision: 2, operationId: 'auto-b' as T.SeatOperationId })
    h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: trigger().sourceId }, mode: 'remind', timeWindows: [], exclusiveTags: [] }]
    await h.engine.drive(); expect(h.creates).toEqual([])
    expect((await h.engine.pending({ limit: 10 })).items[0]?.reason).toBe('approval')
    expect(await h.engine.projectPolicy(projectId)).toEqual({ projectId, mode: 'auto', modeChosen: true, revision: 3 })
    h.definitions.get(seat)!.rules = []
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
    expect([...h.engine.journal.projection.opens.values()][0]?.sources?.map(source => source.eventId)).toEqual(['event-a'])
  })
  it('A09 deduplicates three deliveries and rejects conflicting content', async () => {
    const h = await setup(); await auto(h.engine)
    expect((await h.engine.accept(trigger())).status).toBe('accepted')
    expect((await h.engine.accept(trigger())).status).toBe('duplicate')
    expect((await h.engine.accept(trigger())).status).toBe('duplicate')
    expect(await h.engine.accept({ ...trigger(), data: 'changed' })).toMatchObject({ status: 'rejected', error: { code: 'event-id-conflict' } })
    await h.engine.drive(); expect(h.physical.size).toBe(1)
  })
})
