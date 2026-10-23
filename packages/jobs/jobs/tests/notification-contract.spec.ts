import { expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { JobId, JobRegistry } from '../src/index.ts'
import type { JobEvent, JobIntent, JobNotifications, JobNotificationReservation, JobView } from '../src/index.ts'

it('keeps start synchronous and notification durability independent of terminal job status', () => {
  expectTypeOf<JobRegistry['start']>().returns.toEqualTypeOf<JobId>()
  const intent: JobIntent = { jobId: JobId('bash-a'), kind: 'bash', label: 'task', startedAt: 1 }
  const running = vi.fn()
  const settled = vi.fn<JobNotificationReservation['settled']>()
  const bridge: JobNotifications = { prepare: () => ({ running, settled }) }
  const reservation = bridge.prepare(intent)
  expectTypeOf(reservation).toEqualTypeOf<JobNotificationReservation>()
  reservation.running()
  reservation.settled({ outcome: { status: 'completed' }, finishedAt: 2, cause: 'producer',
    producerReported: true, eventKind: 'job', messageClass: 'handoff', delivery: 'steer' })
  expect(running).toHaveBeenCalledTimes(1)
  expect(settled).toHaveBeenCalledExactlyOnceWith({ outcome: { status: 'completed' }, finishedAt: 2,
    cause: 'producer', producerReported: true, eventKind: 'job', messageClass: 'handoff', delivery: 'steer' })
})

it('keeps real awaited facts independent of optional durable notification ownership', () => {
  const job: JobView = { id: JobId('bash-a'), kind: 'bash', label: 'task', status: 'completed',
    startedAt: 1, finishedAt: 2, output: { total: 0, earliest: 0 } }
  const legacy: JobEvent = { type: 'settled', job, cause: 'producer', awaited: false }
  const durable: JobEvent = { ...legacy, notificationOwner: 'durable' }
  expect(legacy).not.toHaveProperty('notificationOwner')
  expect(durable.awaited).toBe(false)
  expect(durable.job).toBe(legacy.job)
})

it('defaults old providers to best-effort only after the existing access check', () => {
  const id = JobId('bash-a')
  const caller = SessionId('owner')
  const get = vi.fn(() => { throw new Error('foreign job') })
  const receiver = Object.create(JobRegistry.prototype) as JobRegistry
  Object.defineProperty(receiver, 'get', { value: get })
  expect(() => receiver.notificationState(id, caller)).toThrow('foreign job')
  expect(get).toHaveBeenCalledExactlyOnceWith(id, caller)
  const allowed = vi.fn((): JobView => ({ id, kind: 'bash', label: 'task', status: 'running',
    startedAt: 1, output: { total: 0, earliest: 0 } }))
  const authorized = Object.create(JobRegistry.prototype) as JobRegistry
  Object.defineProperty(authorized, 'get', { value: allowed })
  expect(authorized.notificationState(id, caller)).toBe('best-effort')
  expect(allowed).toHaveBeenCalledExactlyOnceWith(id, caller)
})

it('removes an optional notification provider when its registering fiber unloads', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin((scope) => {
    scope.provide('jobNotifications', { prepare: () => ({ running() {}, settled() {} }) })
  })
  expect(ctx.get('jobNotifications')).toBeDefined()
  await fiber.dispose()
  expect(ctx.get('jobNotifications')).toBeUndefined()
  await ctx.fiber.dispose()
})
