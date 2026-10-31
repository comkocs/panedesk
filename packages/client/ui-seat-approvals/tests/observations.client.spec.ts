/** Retention announcements follow projected phases, not the browser clock or modal lifetime. */
import { expect, it } from 'vitest'
import type * as Seat from '@panedesk/dsh-seat'
import { ApprovalObservations } from '../src/client/observations.ts'
import { en, zh } from '../src/client/locales.ts'

it('announces the five-minute and expiry thresholds exactly once across repeated and reopened observations', () => {
  const owner = new ApprovalObservations()
  const item: Seat.PendingSeatItem = { queueItemId: 'q' as Seat.QueueItemId, seat: 's' as Seat.SeatName,
    projectId: 'p' as Seat.SeatProjectId, triggerKind: 'external', action: 'open', sequence: 1,
    effectiveMode: 'remind', reason: 'provider-unavailable', blockedBy: ['provider-unavailable'],
    sources: [], relatedTaskIds: [], queuedAt: '2026-01-01T00:00:00Z', stateVersion: 1 }
  const observe = (remainingMs: number, phase: NonNullable<Seat.PendingSeatObservation['retention']>['phase']) => owner.observe({
    enabled: true, complete: true, items: [{ ...item, retention: { since: 0, deadline: 900000, remainingMs, phase } }],
  }).alerts
  expect(observe(300001, 'retained')).toEqual([])
  const first = observe(300000, 'expiring')
  expect(first).toHaveLength(1)
  expect(observe(1, 'expiring')).toEqual(first)
  const expired = observe(0, 'expired')
  expect(expired?.map(alert => alert.phase)).toEqual(['expiring', 'expired'])
  expect(observe(0, 'expired')).toEqual(expired)
  expect(owner.observe({ enabled: true, complete: true, items: [], rejected: [{ item,
    error: { code: 'gate-denied', message: 'Pre-open retention limit reached', alternative: 'Retry', retryable: false, effectState: 'none' },
  }] }).alerts).toEqual(expired)
})

it('announces a five-minute window a poll first sees after it opened, in both languages', () => {
  const owner = new ApprovalObservations()
  const item: Seat.PendingSeatItem = { queueItemId: 'late' as Seat.QueueItemId, seat: '工位甲' as Seat.SeatName,
    projectId: 'p' as Seat.SeatProjectId, triggerKind: 'external', action: 'open', sequence: 1,
    effectiveMode: 'remind', reason: 'provider-unavailable', blockedBy: ['provider-unavailable'],
    sources: [], relatedTaskIds: [], queuedAt: '2026-01-01T00:00:00Z', stateVersion: 1 }
  const alerts = owner.observe({ enabled: true, complete: true, items: [{ ...item,
    retention: { since: 0, deadline: 900000, remainingMs: 120000, phase: 'expiring' } }] }).alerts
  expect(alerts).toEqual([{ id: 'late:0:expiring', seat: '工位甲', phase: 'expiring' }])
  const seat = alerts?.[0]?.seat ?? ''
  expect(en.expiring.replace('{seat}', seat)).toBe('Retention expires within five minutes: 工位甲')
  expect(zh.expiring.replace('{seat}', seat)).toBe('五分钟内到限：工位甲')
})

it('keeps a terminal announcement across a rebuilt plugin and drops the oldest past 200', () => {
  const memory = new Map<string, string>()
  const storage: Storage = {
    get length() { return memory.size },
    clear: () => { memory.clear() },
    getItem: key => memory.get(key) ?? null,
    key: index => [...memory.keys()][index] ?? null,
    removeItem: (key) => { memory.delete(key) },
    setItem: (key, value) => { memory.set(key, value) },
  }
  const first = new ApprovalObservations(storage)
  const item = (id: string): Seat.PendingSeatItem => ({ queueItemId: id as Seat.QueueItemId, seat: 's' as Seat.SeatName,
    projectId: 'p' as Seat.SeatProjectId, triggerKind: 'external', action: 'open', sequence: 1,
    effectiveMode: 'remind', reason: 'provider-unavailable', blockedBy: ['provider-unavailable'],
    sources: [], relatedTaskIds: [], queuedAt: '2026-01-01T00:00:00Z', stateVersion: 1 })
  for (let index = 0; index < 201; index += 1) {
    first.observe({ enabled: true, complete: true, items: [], rejected: [{ item: item(`q-${index}`),
      error: { code: 'gate-denied', message: 'Pre-open retention limit reached', alternative: 'Retry', retryable: false, effectState: 'none' } }] })
  }
  const rebuilt = new ApprovalObservations(storage)
  const alerts = rebuilt.observe({ enabled: true, complete: true, items: [], rejected: [{ item: item('q-0'),
    error: { code: 'gate-denied', message: 'Pre-open retention limit reached', alternative: 'Retry', retryable: false, effectState: 'none' } }] }).alerts
  expect(alerts).toHaveLength(200)
  expect(alerts?.some(alert => alert.id.startsWith('q-0:'))).toBe(false)
  expect(alerts?.some(alert => alert.id.startsWith('q-200:'))).toBe(true)
})
