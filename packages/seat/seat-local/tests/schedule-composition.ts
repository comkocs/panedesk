/** Host schedule deletion settles local waits without fabricating model completion. */
import { expect, onTestFinished } from 'vitest'
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
  const committed = (waitId: T.WaitId, matches: (wait: T.SeatWait) => boolean) => {
    const completed = Promise.withResolvers<T.SeatWait>()
    const timer = setTimeout(() => {
      off()
      completed.reject(new Error(`Wait ${waitId} did not commit the expected state within five seconds`))
    }, 5000)
    const off = f.ctx.on('seat/decision', (decision) => {
      for (const effect of decision.effects) {
        if ((effect.kind === 'wait/registered' || effect.kind === 'wait/woken')
          && effect.data.waitId === waitId && matches(effect.data)) {
          clearTimeout(timer)
          off()
          completed.resolve(effect.data)
        }
      }
    })
    onTestFinished(() => { clearTimeout(timer); off() })
    return completed.promise
  }
  const wakeCompleted = (waitId: T.WaitId) => {
    const completed = Promise.withResolvers<undefined>()
    let turn: number | undefined
    let wakeTurn: number | undefined
    const off = f.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') turn = event.data.turn
      if (event.type === 'user/message' && event.data.source.kind === 'message-delivery'
        && event.data.content.some(block => block.type === 'text' && block.text.startsWith(`Wait ${waitId}:`))) wakeTurn = turn
      if (event.type !== 'turn/end' || event.data.turn !== wakeTurn) return
      off()
      if (event.data.reason.kind === 'completed') completed.resolve(undefined)
      else completed.reject(new Error(`Schedule wake ended with ${event.data.reason.kind}`))
    })
    onTestFinished(() => { off() })
    return completed.promise
  }
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
  const firstObserved = committed(wait.waitId, value => value.observations.length === 1)
  expect(await schedule.delete({ sessionId, id: first.id })).toMatchObject({ deleted: true })
  await firstObserved
  const registered = await seats.wait(wait.waitId)
  expect(await seats.registerWait(wait)).toEqual({ status: 'registered', wait: registered })
  expect((await seats.wait(wait.waitId))?.phase).toBe('registered')
  expect(adapter.requests).toHaveLength(before)
  expect(await schedule.delete({ sessionId, id: first.id })).toMatchObject({ deleted: false, code: 'schedule_not_found' })
  const cancelledWake = wakeCompleted(wait.waitId)
  const woken = committed(wait.waitId, value => value.phase === 'woken')
  const started = performance.now()
  await Promise.all([cancelledWake, woken, (async () => {
    expect(await schedule.delete({ sessionId, id: second.id })).toMatchObject({ deleted: true })
  })()])
  const elapsedMs = performance.now() - started
  expect(elapsedMs).toBeLessThanOrEqual(5000)
  console.info(JSON.stringify({ scheduleWaitWakeMs: elapsedMs }))
  expect(adapter.requests).toHaveLength(before + 1)
  expect((await seats.wait(wait.waitId))?.observations.every(item => item.outcome === 'cancelled')).toBe(true)
  await f.ctx.agents.get(sessionId)?.whenIdle()
  expect(await schedule.catalog()).toEqual([])
  const original = await woken
  const watermark = (await f.state.read()).watermark
  expect(await seats.registerWait(wait)).toEqual({ status: 'registered', wait: original })
  for (const change of [
    { mode: 'any' as const }, { objects: [] }, { sessionId: 'other-session' as SessionId },
    { operationId: operation('changed-wait') },
    { toolCallId: 'changed-call' as NonNullable<T.RegisterSeatWaitRequest['toolCallId']> },
    { rootCallId: 'changed-root' as NonNullable<T.RegisterSeatWaitRequest['rootCallId']> },
  ]) {
    expect(await seats.registerWait({ ...wait, ...change }))
      .toMatchObject({ status: 'rejected', error: { code: 'wait-id-conflict' } })
  }
  expect(await seats.registerWait({ ...wait, waitId: 'unauthorized-wait' as T.WaitId,
    operationId: operation('unauthorized-wait') }))
    .toMatchObject({ status: 'rejected', error: { code: 'wait-object-unauthorized' } })
  const facts = await f.state.read()
  expect(facts.watermark).toBe(watermark)
  expect(facts.effects.filter(effect => effect.kind === 'wait/woken' && effect.data.waitId === wait.waitId)).toHaveLength(1)
  expect(adapter.requests).toHaveLength(before + 1)
  const due = await schedule.create(sessionId, { title: 'Due check', prompt: 'Consume the due check', after_seconds: 1 })
  const dueWait: T.RegisterSeatWaitRequest = { sessionId, waitId: 'schedule-due' as T.WaitId, mode: 'all',
    objects: [{ kind: 'schedule', id: due.id }], operationId: operation('schedule-due') }
  const dueBefore = adapter.requests.length
  const dueWake = wakeCompleted(dueWait.waitId)
  const dueWoken = committed(dueWait.waitId, value => value.phase === 'woken')
  await Promise.all([dueWake, dueWoken, (async () => {
    expect(await seats.registerWait(dueWait)).toMatchObject({ status: 'registered' })
  })()])
  expect((await seats.wait(dueWait.waitId))?.observations).toMatchObject([{ outcome: 'completed' }])
  expect(adapter.requests).toHaveLength(dueBefore + 2)
  await f.ctx.agents.get(sessionId)?.whenIdle()
  expect(await seats.registerWait(dueWait)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
  expect(await schedule.delete({ sessionId, id: due.id })).toMatchObject({ deleted: true })
  expect(adapter.requests).toHaveLength(dueBefore + 2)
}
