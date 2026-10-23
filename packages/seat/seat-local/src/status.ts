/** Runtime evidence is independent of model self-reports and title text. */
import type { SeatBusyReason, SeatCacheEvidence, SeatFailure, SeatWindowStatus } from '@panedesk/dsh-seat'
import { rejected } from './errors.ts'

/** Complete runtime facts collected under a window's admission watermark. */
export interface WindowEvidence {
  complete: boolean
  running: boolean
  approvals: readonly string[]
  planReviews: readonly string[]
  answers: readonly string[]
  subagents: readonly string[]
  jobs: readonly string[]
  waits: readonly string[]
  tickets: readonly string[]
  inbox: readonly string[]
  lastConsumedTurn: 'completed' | 'other' | null
  droppedUnrun: boolean
  lastActivityAt: string | null
  stateVersion: number
}

/** Aggregate six display states without mistaking missing ownership for idle.
 * @param facts - current runtime snapshot, never a model claim.
 * @returns display state and all outstanding work.
 */
export function readWindowStatus(facts: WindowEvidence): { status: SeatWindowStatus | null; busyReasons: SeatBusyReason[] } {
  const busyReasons: SeatBusyReason[] = []
  if (!facts.complete) busyReasons.push({ kind: 'owner-unknown', summary: 'Runtime ownership is unavailable.' })
  if (facts.running) busyReasons.push({ kind: 'turn', summary: 'A turn is running.' })
  const groups = [
    ['approval', facts.approvals], ['plan-review', facts.planReviews], ['answer', facts.answers],
    ['subagent', facts.subagents], ['job', facts.jobs], ['wait', facts.waits],
    ['ticket', facts.tickets], ['inbox', facts.inbox],
  ] as const
  for (const [kind, ids] of groups) for (const objectId of ids) busyReasons.push({ kind, objectId, summary: `${kind}: ${objectId}` })
  const status = !facts.complete ? null : facts.approvals.length ? 'approval-pending'
    : facts.planReviews.length ? 'plan-review-pending' : facts.answers.length ? 'answer-pending'
      : facts.running ? 'running' : busyReasons.length === 0 && facts.lastConsumedTurn === 'completed' && !facts.droppedUnrun ? 'completed' : 'idle'
  return { status, busyReasons }
}

/** Reject renewal unless the complete reusable cache evidence still covers the idle interval.
 * @param facts - runtime activity snapshot.
 * @param cache - upstream cache evidence.
 * @param now - host clock in milliseconds.
 * @returns refusal or null; the upstream executor must recheck before sending maintenance.
 */
export function renewalRefusal(facts: WindowEvidence, cache: SeatCacheEvidence, now: number): SeatFailure | null {
  if (readWindowStatus(facts).busyReasons.length) return rejected('session-busy', 'The window still has outstanding work.', 'Wait for the listed work to settle.').error
  const last = cache.lastActivityAt === null ? NaN : Date.parse(cache.lastActivityAt)
  if (!Number.isFinite(last) || last > now || cache.cacheTtlMs === null || !cache.reusableRequest || cache.prefixDigest === null) {
    return rejected('cache-evidence-unavailable', 'Reusable cache evidence is unavailable.', 'Send a normal task instead of renewing an unknown cache.').error
  }
  if (now - last > cache.cacheTtlMs) return rejected('cache-expired', 'The window cache has expired.', 'Send a normal task instead of renewing an expired cache.').error
  return null
}
