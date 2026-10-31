/** Retention announcements follow projected phases, not the browser clock or modal lifetime. */
import { expect, it } from 'vitest'
import type * as Seat from '@panedesk/dsh-seat'
import { ApprovalObservations } from '../src/client/observations.ts'

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
