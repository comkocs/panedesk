import { afterEach, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, projectId, seat, sourceId, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  cleanups.push(h.close)
  return h
}
const reminders = async (engine: T.SeatEngineService) => (await engine.query({ kinds: ['queue/reminded'], limit: 100 })).effects

it('commits and publishes one complete approval reminder with the first pending item', async () => {
  const h = await setup()
  const published: T.EngineDecision[] = []
  h.ctx.on('seat/decision', (decision) => { published.push(decision) })
  const stream = h.engine.subscribe()[Symbol.asyncIterator]()
  const next = stream.next()
  await h.engine.accept(trigger())
  const [pending] = (await h.engine.pending({ limit: 10 })).items
  const effects = await reminders(h.engine)
  expect(effects).toHaveLength(1)
  if (effects[0]?.kind !== 'queue/reminded') throw new Error('Missing reminder')
  expect(effects[0].eventId).toBeTypeOf('string')
  expect(effects[0]).toEqual({ kind: 'queue/reminded', eventId: effects[0].eventId, seat, triggerId: 'event-a', data: {
    queueItemId: pending!.queueItemId, seat, projectId, triggerKind: 'external', reason: 'approval',
    triggerId: 'event-a', sequence: pending!.sequence, stateVersion: pending!.stateVersion, remindedAt: effects[0].data.remindedAt,
  } })
  expect(Number.isFinite(Date.parse(effects[0].data.remindedAt))).toBe(true)
  expect(published).toHaveLength(1)
  expect(published[0]!.effects.map(effect => effect.kind)).toEqual(['trigger/accepted', 'queue/reminded'])
  expect((await next).value).toEqual(published[0])
  await stream.return?.()
  expect(JSON.stringify(effects)).not.toContain('Begin the assigned task.')
})

it('retains one reminder through redelivery, coalescing, host replay and approved opening', async () => {
  const h = await setup()
  await h.engine.accept(trigger())
  const first = await reminders(h.engine)
  expect((await h.engine.accept(trigger())).status).toBe('duplicate')
  expect((await h.engine.accept(trigger('external', 'event-b'))).status).toBe('coalesced')
  await h.engine.drive()
  expect(await reminders(h.engine)).toEqual(first)
  await h.engine.shutdown()
  const restarted = await h.start()
  await restarted.drive()
  expect((await restarted.accept(trigger())).status).toBe('duplicate')
  expect((await restarted.accept(trigger('external', 'event-c'))).status).toBe('coalesced')
  expect(await reminders(restarted)).toEqual(first)
  const pending = (await restarted.pending({ limit: 10 })).items[0]!
  await restarted.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'approve-a' as T.SeatOperationId })
  await restarted.drive()
  expect(h.creates).toHaveLength(1)
  expect(await reminders(restarted)).toEqual(first)
})

it.each(['auto', 'off'] as const)('emits no reminder in project %s mode', async (mode) => {
  const h = await setup()
  await h.engine.setProjectMode({ projectId, mode, expectedRevision: 0, operationId: 'mode-a' as T.SeatOperationId })
  await h.engine.accept(trigger())
  await h.engine.drive()
  expect(await reminders(h.engine)).toEqual([])
})

it.each(['project', 'rule', 'coalescing'] as const)('reminds once when %s tightening moves existing work into approval', async (restriction) => {
  const h = await setup()
  await auto(h.engine)
  await h.engine.accept(trigger())
  const original = (await h.engine.pending({ limit: 10 })).items[0]!
  if (restriction === 'rule') {
    h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
      trigger: { kind: 'external', sourceId }, mode: 'remind', timeWindows: [], exclusiveTags: [] }]
  } else {
    await h.engine.setProjectMode({ projectId, mode: 'remind', expectedRevision: 1, operationId: 'mode-b' as T.SeatOperationId })
  }
  if (restriction === 'coalescing') await h.engine.accept(trigger('external', 'event-b'))
  await h.engine.drive()
  await h.engine.drive()
  const effects = await reminders(h.engine)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({ data: { queueItemId: original.queueItemId, triggerId: 'event-a',
    sequence: original.sequence, stateVersion: original.stateVersion + 1 } })
  const decision = h.engine.journal.projection.decisions.find(item => item.effects.some(effect => effect.kind === 'queue/reminded'))!
  expect(decision.effects.map(effect => effect.kind)).toEqual([
    restriction === 'coalescing' ? 'trigger/coalesced' : 'queue/pending', 'queue/reminded',
  ])
  expect(h.creates).toEqual([])
})

it('reminds on first acceptance when an automatic project has a reminder-only rule', async () => {
  const h = await setup()
  await auto(h.engine)
  h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
    trigger: { kind: 'external', sourceId }, mode: 'remind', timeWindows: [], exclusiveTags: [] }]
  await h.engine.accept(trigger())
  await h.engine.drive()
  expect(await reminders(h.engine)).toHaveLength(1)
  expect(h.creates).toEqual([])
})

it('uses a new reminder identity when approved blocked work reenters approval', async () => {
  const h = await setup()
  h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
    trigger: { kind: 'external', sourceId }, windowBudgetUsd: '1000' as T.MicroUsd, timeWindows: [], exclusiveTags: [] }]
  await h.engine.accept(trigger())
  const pending = (await h.engine.pending({ limit: 10 })).items[0]!
  await h.engine.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'approve-a' as T.SeatOperationId })
  h.state.snapshot.complete = false
  await h.engine.drive()
  expect((await h.engine.pending({ limit: 10 })).items[0]!.reason).toBe('budget-unverifiable')
  await h.engine.accept(trigger('external', 'event-b'))
  const effects = await reminders(h.engine)
  expect(effects).toHaveLength(2)
  expect(effects[1]).toMatchObject({ data: { queueItemId: pending.queueItemId, stateVersion: 4, triggerId: 'event-a' } })
  expect(effects[1]!.eventId).not.toBe(effects[0]!.eventId)
})

it('reminds for a new approval transition after leaving approval or cancelling the queue item', async () => {
  const h = await setup()
  await h.engine.accept(trigger())
  const first = (await reminders(h.engine))[0]!
  await h.engine.setProjectMode({ projectId, mode: 'off', expectedRevision: 0, operationId: 'off-a' as T.SeatOperationId })
  await h.engine.drive()
  await h.engine.setProjectMode({ projectId, mode: 'remind', expectedRevision: 1, operationId: 'remind-a' as T.SeatOperationId })
  await h.engine.drive()
  const second = (await reminders(h.engine))[1]!
  expect(second.eventId).not.toBe(first.eventId)
  expect(second).toMatchObject({ data: { stateVersion: 3 } })
  const pending = (await h.engine.pending({ limit: 10 })).items[0]!
  await h.engine.cancel({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'cancel-a' as T.SeatOperationId })
  await h.engine.accept(trigger('external', 'event-b'))
  const effects = await reminders(h.engine)
  expect(effects).toHaveLength(3)
  expect(effects[2]).not.toMatchObject({ data: { queueItemId: pending.queueItemId } })
})
