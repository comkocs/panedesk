/** Owner notifications precede slow call repair and retain terminal fencing. */
import { describe, expect, it, vi } from 'vitest'
import type { LedgerEvent, LedgerLifecycle, LedgerCall, LedgerRunFinish, LedgerWatermark } from '@panedesk/dsh-session-ledger'
import { reconcileRuns, type WatchLedger } from '../src/watch.ts'
import type { LedgerOwnerSettled } from '../src/types.ts'

function fixture() {
  const row: LedgerLifecycle = { kind: 'run', liveness: 'unknown', start: {
    runId: 'run-a' as LedgerLifecycle['start']['runId'], sessionId: 'window-a' as LedgerLifecycle['start']['sessionId'],
    rootSessionId: 'window-a' as LedgerLifecycle['start']['rootSessionId'], nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'],
    seat: 'seat-a', window: 'window-a', accountLabel: 'unknown', identitySource: 'startup',
    startedAt: 100, launchState: 'started', deliveryPaths: [], processIdentity: {
      nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'], pid: 123, startIdentity: '456',
      bootIdentity: 'boot-a', registeredAt: 100, verification: 'verified',
    },
  } }
  const call: LedgerCall = { kind: 'call', start: { ...row.start,
    callId: 'call-a' as LedgerCall['start']['callId'], logicalRequestId: 'request-a' as LedgerCall['start']['logicalRequestId'],
    attemptIndex: 0, attemptVisibility: 'physical', provider: 'mock', modelFamily: 'mock', requestedModel: 'model-a',
    purpose: 'conversation', cache: { breakReasons: [], cacheMode: 'unknown' }, cacheWriteTiering: { kind: 'unknown' },
    priceVersion: 'unknown', priceKey: 'unknown', referencePrice: true,
  } }
  let clock = 1000
  const terminal = (finish: LedgerRunFinish): LedgerEvent => ({ schemaVersion: 1,
    eventId: 'terminal-a' as LedgerEvent['eventId'], nodeId: row.start.nodeId,
    sessionId: row.start.sessionId, runId: row.start.runId, observedAt: clock, kind: 'run/end', data: finish })
  const ledger: WatchLedger = {
    snapshot: async () => ({ asOf: clock, complete: true, watermarks: {}, rows: [row, call] }),
    finishRun: async (finish) => {
      clock += 100
      const existed = row.finish !== undefined
      row.finish ??= finish
      return { kind: existed ? 'existing' : 'appended', event: terminal(row.finish), watermark: 'watermark-a' as LedgerWatermark }
    },
    finishCall: async (finish) => {
      clock += 6000
      call.finish = finish
      return { kind: 'appended', event: { ...terminal(row.finish!), kind: 'call/end', data: finish }, watermark: 'watermark-a' as LedgerWatermark }
    },
    appendEvent: async event => ({ kind: 'appended', event, watermark: 'watermark-a' as LedgerWatermark }),
  }
  return { row, call, ledger, options: { nodeId: row.start.nodeId, intervalMs: 2000, settlementBudgetMs: 10000,
    now: () => clock, monotonic: () => clock,
    inspect: async () => ({ liveness: 'dead' as const, verification: 'verified' as const, reason: 'missing' as const }),
  } }
}

describe('owner release notification', () => {
  it('notifies the exact durable dead owner within five seconds before slow call repair', async () => {
    const f = fixture()
    const notices: LedgerOwnerSettled[] = []
    await reconcileRuns(f.ledger, { ...f.options, onOwnerSettled: (payload) => {
      expect(f.row.finish).toEqual(payload.finish)
      expect(f.call.finish).toBeUndefined()
      notices.push(payload)
    } })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ start: { runId: 'run-a', sessionId: 'window-a', nodeId: 'node-a' },
      finish: { endReason: 'killed', recovered: true }, latencyMs: 100 })
    expect(notices[0]!.persistedAt - notices[0]!.deathObservedAt).toBeLessThanOrEqual(5000)
    expect(f.call.finish?.endReason).toBe('killed')
  })

  it('does not release unknown identities or a racing normal terminal', async () => {
    const f = fixture()
    const notify = vi.fn()
    await reconcileRuns(f.ledger, { ...f.options, onOwnerSettled: notify,
      inspect: async () => ({ liveness: 'unknown', verification: 'unverified', reason: 'unreadable' }) })
    expect(notify).not.toHaveBeenCalled()
    const finishRun = f.ledger.finishRun
    f.ledger.finishRun = async (finish) => {
      f.row.finish = { ...finish, endReason: 'completed', recovered: false }
      return finishRun(finish)
    }
    await reconcileRuns(f.ledger, { ...f.options, onOwnerSettled: notify })
    expect(notify).not.toHaveBeenCalled()
    expect(f.call.finish).toBeUndefined()
  })

  it('contains notification failures without skipping existing call repair', async () => {
    const f = fixture()
    const report = await reconcileRuns(f.ledger, { ...f.options, onOwnerSettled: () => { throw new Error('listener failed') } })
    expect(report.alerts).toContain('watch-owner-notification-failed')
    expect(f.call.finish?.endReason).toBe('killed')
  })
})
