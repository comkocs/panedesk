/** Host schedule deletion settles local waits without fabricating model completion. */
import { expect } from 'vitest'
import Schedule from '@panedesk/dsh-schedule'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { engineFixture } from './engine-fixture.ts'
import type { CreationAdapter } from './creation-provider.ts'
import { operation } from './fixtures.ts'

/** Compose the real Host scheduler and delete two independently owned recurring tasks.
 * @param f - real local seat composition.
 * @param sessionId - waiting Session.
 * @param adapter - deterministic external model transport.
 */
export async function checkScheduleDeletion(f: Awaited<ReturnType<typeof engineFixture>>, sessionId: SessionId,
  adapter: CreationAdapter): Promise<void> {
  f.ctx.loader.builtins.schedule = Schedule
  const path = join(f.options.directory, 'schedule.yml')
  await writeFile(path, JSON.stringify([{ name: 'cordis:schedule', config: {} }]))
  await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await f.ctx.loader.await()
  const service = f.ctx.get('seats')
  const schedule = f.ctx.get('schedule')
  if (!service || !schedule) throw new Error('Schedule composition did not load')
  const seats = service.withAuthority({ principalId: 'schedule-owner' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId })
  const request = { title: 'Recurring check', prompt: 'Check work', every_seconds: 3600 }
  const first = await schedule.create(sessionId, request)
  const second = await schedule.create(sessionId, request)
  expect(first.id).not.toBe(second.id)
  const wait: T.RegisterSeatWaitRequest = { sessionId, waitId: 'schedule-wait' as T.WaitId, mode: 'all',
    objects: [{ kind: 'schedule', id: first.id }, { kind: 'schedule', id: second.id }], operationId: operation('schedule-wait') }
  expect(await seats.registerWait(wait)).toMatchObject({ status: 'registered', wait: { phase: 'registered' } })
  const before = adapter.requests.length
  expect(await schedule.delete({ sessionId, id: first.id })).toMatchObject({ deleted: true })
  await expect.poll(async () => (await seats.wait(wait.waitId))?.observations.length).toBe(1)
  expect((await seats.wait(wait.waitId))?.phase).toBe('registered')
  expect(adapter.requests).toHaveLength(before)
  expect(await schedule.delete({ sessionId, id: first.id })).toMatchObject({ deleted: false, code: 'schedule_not_found' })
  expect(await schedule.delete({ sessionId, id: second.id })).toMatchObject({ deleted: true })
  await expect.poll(async () => (await seats.wait(wait.waitId))?.phase).toBe('woken')
  await expect.poll(() => adapter.requests.length).toBe(before + 1)
  expect((await seats.wait(wait.waitId))?.observations.every(item => item.outcome === 'cancelled')).toBe(true)
  await f.ctx.agents.get(sessionId)?.whenIdle()
  expect(await schedule.catalog()).toEqual([])
  const due = await schedule.create(sessionId, { title: 'Due check', prompt: 'Consume the due check', after_seconds: 1 })
  const dueWait: T.RegisterSeatWaitRequest = { sessionId, waitId: 'schedule-due' as T.WaitId, mode: 'all',
    objects: [{ kind: 'schedule', id: due.id }], operationId: operation('schedule-due') }
  expect(await seats.registerWait(dueWait)).toMatchObject({ status: 'registered' })
  const dueBefore = adapter.requests.length
  await expect.poll(async () => (await seats.wait(dueWait.waitId))?.phase, { timeout: 4000 }).toBe('woken')
  expect((await seats.wait(dueWait.waitId))?.observations).toMatchObject([{ outcome: 'completed' }])
  await expect.poll(() => adapter.requests.length).toBe(dueBefore + 2)
  await f.ctx.agents.get(sessionId)?.whenIdle()
  expect(await seats.registerWait(dueWait)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
  expect(await schedule.delete({ sessionId, id: due.id })).toMatchObject({ deleted: true })
  expect(adapter.requests).toHaveLength(dueBefore + 2)
}
