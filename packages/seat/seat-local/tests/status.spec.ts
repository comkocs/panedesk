import { describe, expect, it } from 'vitest'
import type { SeatCacheEvidence, SeatDigest } from '@panedesk/dsh-seat'
import { readWindowStatus, renewalRefusal, type WindowEvidence } from '../src/status.ts'

export function idleEvidence(overrides: Partial<WindowEvidence> = {}): WindowEvidence {
  return { complete: true, running: false, approvals: [], planReviews: [], answers: [], subagents: [], jobs: [],
    waits: [], tickets: [], inbox: [], lastConsumedTurn: null, droppedUnrun: false,
    lastActivityAt: '2026-01-01T00:00:00.000Z', stateVersion: 1, ...overrides }
}

describe('window status and renewal admission', () => {
  it.each([
    [{ running: true }, 'running'], [{}, 'idle'], [{ approvals: ['approval-a'], running: true }, 'approval-pending'],
    [{ planReviews: ['plan-a'] }, 'plan-review-pending'], [{ answers: ['answer-a'] }, 'answer-pending'],
    [{ lastConsumedTurn: 'completed' }, 'completed'], [{ complete: false }, null],
  ] as const)('derives status from runtime evidence %j', (facts, status) => {
    expect(readWindowStatus(idleEvidence(facts)).status).toBe(status)
  })

  it('retains all busy reasons and never completes dropped or pending work', () => {
    const view = readWindowStatus(idleEvidence({ running: true, approvals: ['approval-a'], jobs: ['job-a'], subagents: ['child-a'] }))
    expect(view.status).toBe('approval-pending')
    expect(view.busyReasons.map(item => item.kind)).toEqual(['turn', 'approval', 'subagent', 'job'])
    expect(readWindowStatus(idleEvidence({ lastConsumedTurn: 'completed', droppedUnrun: true })).status).toBe('idle')
    expect(readWindowStatus(idleEvidence({ lastConsumedTurn: 'completed', inbox: ['message-a'] })).status).toBe('idle')
    expect(readWindowStatus(idleEvidence({ complete: false })).busyReasons[0]?.kind).toBe('owner-unknown')
  })

  it('admits thirty-minute idle only within its own TTL and rejects missing activity', () => {
    const cache: SeatCacheEvidence = { lastActivityAt: '2026-01-01T00:00:00.000Z', cacheTtlMs: 3600000,
      prefixDigest: 'prefix-a' as SeatDigest, observedAt: '2026-01-01T00:30:00.000Z', reusableRequest: true }
    const now = Date.parse(cache.observedAt)
    expect(renewalRefusal(idleEvidence(), cache, now)).toBeNull()
    expect(renewalRefusal(idleEvidence(), { ...cache, cacheTtlMs: 300000 }, now)?.code).toBe('cache-expired')
    expect(renewalRefusal(idleEvidence(), { ...cache, lastActivityAt: null }, now)?.code).toBe('cache-evidence-unavailable')
    expect(renewalRefusal(idleEvidence({ jobs: ['job-a'] }), cache, now)?.code).toBe('session-busy')
  })
})
