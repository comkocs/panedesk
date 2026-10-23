import { describe, expect, it } from 'vitest'
import type { SeatCacheEvidence, SeatContextUsage } from '@panedesk/dsh-seat'
import { checkContinuation } from '../src/continuation.ts'

const now = Date.parse('2026-01-01T01:00:00Z')
const cache: SeatCacheEvidence = { lastActivityAt: '2026-01-01T00:00:00Z', cacheTtlMs: 3600000, prefixDigest: null, observedAt: '2026-01-01T01:00:00Z', reusableRequest: true }
const context: SeatContextUsage = { status: 'known', source: 'last-call-usage', tokens: 399999, observedAt: cache.observedAt, estimated: true, contextEpoch: 1 }

describe('child-owned continuation admission', () => {
  it('allows the exact cache boundary and rejects an expired child with a new-dispatch alternative', () => {
    expect(checkContinuation(cache, context, 400000, now)).toBeNull()
    expect(checkContinuation(cache, context, 400000, now + 1)).toMatchObject({ code: 'subagent-renewal-expired', alternative: 'Start a new subagent with the handoff summary.', effectState: 'none' })
  })
  it('rejects continuation at the context threshold independently of cache freshness', () => {
    expect(checkContinuation(cache, { ...context, tokens: 400000 }, 400000, now)).toMatchObject({ code: 'subagent-context-limit', alternative: 'Start a new subagent with the handoff summary.' })
  })
  it('does not claim renewal eligibility with unknown child evidence', () => {
    expect(checkContinuation({ ...cache, cacheTtlMs: null }, context, 400000, now)?.code).toBe('evidence-unavailable')
    expect(checkContinuation(cache, { status: 'unknown', observedAt: cache.observedAt }, 400000, now)?.code).toBe('evidence-unavailable')
    expect(checkContinuation({ ...cache, lastActivityAt: null }, context, 400000, now)?.code).toBe('evidence-unavailable')
  })
})
