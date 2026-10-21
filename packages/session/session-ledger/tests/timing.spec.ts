import { describe, expect, it } from 'vitest'
import { foldIntervals } from '../src/timing.ts'
import { makeAlert } from '../src/alerts.ts'
import type { LedgerInterval } from '../src/types.ts'

describe('timing', () => {
  it('unions same-category intervals, preserves overlap, and deduplicates tool IDs', () => {
    const a = 'tool-a' as NonNullable<LedgerInterval['toolCallId']>
    const b = 'tool-b' as NonNullable<LedgerInterval['toolCallId']>
    const intervals: LedgerInterval[] = [
      { kind: 'sleep', startedAt: 0, endedAt: 30000, toolCallId: a },
      { kind: 'sleep', startedAt: 0, endedAt: 30000, toolCallId: a },
      { kind: 'sleep', startedAt: 20000, endedAt: 40000, toolCallId: b },
      { kind: 'subagent', startedAt: 10000, endedAt: 30000, toolCallId: b },
    ]
    expect(foldIntervals(intervals)).toEqual({ categories: {
      sleep: { durationMs: 40000, rawMs: 50000, toolCalls: 2 }, subagent: { durationMs: 20000, rawMs: 20000, toolCalls: 1 },
    }, waitMs: 40000, rawWaitMs: 70000 })
  })
  it('uses monotonic durations across wall-clock shifts and ignores open observations', () => {
    expect(foldIntervals([{ kind: 'sleep', startedAt: 100, endedAt: 10, durationMs: 30 }, { kind: 'sleep', startedAt: 1 }]).waitMs).toBe(30)
    expect(foldIntervals([{ kind: 'model-in-flight', startedAt: 0, endedAt: 50 }]).waitMs).toBe(0)
  })
  it('keeps arbitrary sensitive diagnostics out of category-owned alerts', () => {
    const alert = makeAlert('disconnect', 'Authorization: Bearer fake-sensitive-value')
    expect(alert).toEqual({ code: 'disconnect', message: 'The provider stream disconnected.', redacted: true })
    expect(JSON.stringify(alert)).not.toContain('fake-sensitive-value')
    expect(makeAlert('ledger-unavailable').redacted).toBe(false)
  })
})
