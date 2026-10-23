/** Action handlers use independent storage and the existing Host timer. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScheduleId, createAfterScheduleRecord, createEveryScheduleRecord } from '../src/domain.ts'
import type { ScheduleActionDispatch } from '../src/types.ts'
import { harness } from './harness.ts'

const contexts: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const test = await harness(options)
  contexts.push(test)
  return test
}

it('dispatches the selected seat without resolving a Session and acknowledges the scheduled identity', async () => {
  const test = await setup()
  const accept = vi.fn(async (_request: ScheduleActionDispatch) => ({ status: 'accepted' as const }))
  test.service.registerAction('seat.open', accept)
  const record = createAfterScheduleRecord(ScheduleId('seat-open'), 'Open seat', 2, Date.now(), 'Open seat')
  await test.service.scheduleAction({ record, actionId: 'seat.open', payload: { seat: 'seat-a' } })
  await vi.advanceTimersByTimeAsync(2000)
  expect(accept).toHaveBeenCalledExactlyOnceWith({ record, actionId: 'seat.open', payload: { seat: 'seat-a' },
    scheduledAt: record.scheduledAt, eventId: `${record.id}:${record.scheduledAt}` })
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await test.service.listActions()).toMatchObject([{ status: 'inactive', lastReceipt: { status: 'accepted' } }])
  expect(await test.service.catalog()).toEqual([])
})

it('retains unavailable handlers and delivers a timed wait within five seconds without sleep calls', async () => {
  const test = await setup()
  const record = createAfterScheduleRecord(ScheduleId('wait'), 'Wait', 1, Date.now(), 'Wait')
  await test.service.scheduleAction({ record, actionId: 'seat.wait', payload: { waitId: 'wait-a' } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await test.service.listActions()).toMatchObject([{ status: 'active', available: false }])
  const observations: { kind: string; id: string; delay: number }[] = []
  const dispose = test.service.registerAction('seat.wait', async (request) => {
    observations.push({ kind: 'schedule', id: request.record.id, delay: Date.now() - Date.parse(request.scheduledAt) })
    return { status: 'accepted' }
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(observations).toEqual([{ kind: 'schedule', id: 'wait', delay: 0 }])
  expect(observations[0]!.delay).toBeLessThanOrEqual(5000)
  await dispose()
  expect(await test.service.listActions()).toMatchObject([{ available: false }])
  expect(test.resolve).not.toHaveBeenCalled()
})

it('replays the frozen occurrence after restart and advances disabled occurrences without backlog', async () => {
  const first = await setup()
  const record = createEveryScheduleRecord(ScheduleId('restart'), 'Open seat', 60, Date.now(), 'Open seat')
  let eventId: string | undefined
  first.service.registerAction('seat.open', async (request) => { eventId = request.eventId; throw new Error('accept unavailable') })
  await first.service.scheduleAction({ record, actionId: 'seat.open', payload: { seat: 'seat-b' } })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await first.service.listActions()).toMatchObject([{ status: 'active', pending: { eventId } }])
  await first.ctx.fiber.dispose()
  const second = await setup({ pool: first.pool })
  const accept = vi.fn(async (_request: ScheduleActionDispatch) => ({ status: 'skipped-disabled' as const }))
  second.service.registerAction('seat.open', accept)
  await vi.advanceTimersByTimeAsync(0)
  expect(accept.mock.calls[0]![0].eventId).toBe(eventId)
  expect(await second.service.listActions()).toMatchObject([{ lastReceipt: { status: 'skipped-disabled' },
    record: { scheduledAt: '2026-09-16T00:02:00.000Z' } }])
  expect(await second.service.deleteAction(record.id)).toBe(true)
  expect(await second.service.deleteAction(record.id)).toBe(false)
})

it('removes action handlers with their registering fiber and resumes the same pending occurrence after reload', async () => {
  const test = await setup()
  const first = vi.fn(async (_request: ScheduleActionDispatch) => ({ status: 'accepted' as const }))
  const fiber = await test.ctx.plugin({ inject: ['schedule'], apply(scope) { scope.schedule.registerAction('seat.open', first) } })
  const record = createAfterScheduleRecord(ScheduleId('reload'), 'Open seat', 1, Date.now(), 'Open seat')
  await test.service.scheduleAction({ record, actionId: 'seat.open', payload: { seat: 'seat-a' } })
  await fiber.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect(first).not.toHaveBeenCalled()
  expect(await test.service.listActions()).toMatchObject([{ status: 'active', available: false }])
  const second = vi.fn(async (_request: ScheduleActionDispatch) => ({ status: 'accepted' as const }))
  await test.ctx.plugin({ inject: ['schedule'], apply(scope) { scope.schedule.registerAction('seat.open', second) } })
  await vi.advanceTimersByTimeAsync(0)
  expect(second).toHaveBeenCalledExactlyOnceWith({ record, actionId: 'seat.open', payload: { seat: 'seat-a' },
    eventId: `${record.id}:${record.scheduledAt}`, scheduledAt: record.scheduledAt })
})

it('does not change reminder catalogs when no action handler is installed', async () => {
  const test = await setup()
  expect(await test.service.listActions()).toEqual([])
  expect(await test.service.catalog()).toEqual([])
  expect(test.resolve).not.toHaveBeenCalled()
})
