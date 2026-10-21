import { Context } from '@panedesk/cordis'
import { describe, expect, it } from 'vitest'
import type { LedgerCall, LedgerEvent, LedgerLifecycle, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { SessionLedger } from '@panedesk/dsh-session-ledger'
import { LedgerQueryService } from '../src/index.ts'
import { cacheRemaining, liveSessions, selectLedger, sumUsd, summarizeToday } from '../src/query.ts'
import { parseLedgerExport, serializeLedger, verifyLedger } from '../src/export.ts'

const midnight = Date.parse('2026-10-21T16:00:00Z')
const asOf = midnight + 60000
function call(id: string, startedAt = midnight + 1): LedgerCall {
  return { kind: 'call', start: {
    callId: id as LedgerCall['start']['callId'], runId: 'run-a' as LedgerCall['start']['runId'],
    logicalRequestId: 'request-a' as LedgerCall['start']['logicalRequestId'], sessionId: 'session-a' as LedgerCall['start']['sessionId'],
    rootSessionId: 'session-a' as LedgerCall['start']['rootSessionId'], nodeId: 'node-a' as LedgerCall['start']['nodeId'],
    seat: 'seat-a', window: 'window-a', taskId: 'task-a', accountLabel: 'account-a', identitySource: 'startup',
    attemptIndex: 0, attemptVisibility: 'physical', provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'model-a', purpose: 'conversation',
    startedAt, cache: { cacheMode: 'explicit', breakReasons: [] }, cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' },
    priceVersion: 'fixture-v1', priceKey: 'model-a', referencePrice: true,
  }, finish: { callId: id as LedgerCall['start']['callId'], endedAt: asOf - 1, observedAt: asOf - 1,
    effectiveModel: 'model-a', responseModelReported: 'same', responseModel: 'model-a',
    usage: { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10, cacheWriteLongTokens: 4, outputTokens: 5 }, usageState: 'complete',
    costUsd: '0.100001', pricingState: 'priced', wallMs: 1, modelInFlightMs: 1, queueMs: 0, backoffMs: 0, waits: [],
    compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false } }
}
function run(id: string, node = 'node-a'): LedgerLifecycle {
  const c = call(id)
  return { kind: 'run', start: { ...c.start, runId: id as LedgerLifecycle['start']['runId'], sessionId: id as LedgerLifecycle['start']['sessionId'],
    nodeId: node as LedgerLifecycle['start']['nodeId'], launchState: 'started', deliveryPaths: [],
    processIdentity: { nodeId: node as LedgerLifecycle['start']['nodeId'], pid: 100, startIdentity: '123', bootIdentity: 'boot-a', registeredAt: midnight, verification: 'verified' } }, liveness: 'confirmed' }
}
function observed(row: LedgerLifecycle, liveness: LedgerLifecycle['liveness'], time = asOf - 100): LedgerEvent {
  return { schemaVersion: 1, eventId: `event-${row.start.runId}` as LedgerEvent['eventId'], nodeId: row.start.nodeId,
    observedAt: time, runId: row.start.runId, sessionId: row.start.sessionId, kind: 'process/observed', identity: row.start.processIdentity!, liveness }
}
function snapshot(rows: LedgerSnapshot['rows']): LedgerSnapshot { return { asOf, rows, complete: true, watermarks: { 'node-a': 'watermark-a' as LedgerSnapshot['watermarks'][string] } } }

class MemoryLedger extends SessionLedger {
  constructor(ctx: Context, private readonly data: LedgerSnapshot) { super(ctx) }
  async snapshot() { return this.data }
  async query() { return this.data }
  beginCall(): never { throw new Error('Read-only fixture') }
  finishCall(): never { throw new Error('Read-only fixture') }
  beginRun(): never { throw new Error('Read-only fixture') }
  finishRun(): never { throw new Error('Read-only fixture') }
  appendEvent(): never { throw new Error('Read-only fixture') }
  appendArtifact(): never { throw new Error('Read-only fixture') }
  finishArtifact(): never { throw new Error('Read-only fixture') }
  registerWaitTool(): never { throw new Error('Read-only fixture') }
  priceUsage(): never { throw new Error('Read-only fixture') }
}

describe('daily ledger projections', () => {
  it('assigns midnight-crossing calls by start and independently recomputes the four numbers', () => {
    const before = call('before', midnight - 1), normal = call('normal'), keepalive = call('keepalive', midnight)
    keepalive.start.purpose = 'keepalive'; keepalive.finish!.costUsd = '0.2'
    const future = call('future', asOf), live = run('live'), dead = run('dead'), unknown = run('unknown', 'node-b')
    const data = snapshot([before, normal, keepalive, future, live, dead, unknown,
      { kind: 'event', event: observed(live, 'confirmed') }, { kind: 'event', event: observed(dead, 'dead') }])
    const result = summarizeToday(data, asOf, 10000)
    const independentCalls = [normal, keepalive]
    const independentTokens = independentCalls.reduce((sum, row) => {
      const u = row.finish!.usage!
      return sum + u.inputTokens + u.cacheReadTokens! + u.cacheWriteTokens! + u.outputTokens
    }, 0)
    expect(result).toMatchObject({ from: midnight, costUsd: '0.300001', keepaliveCostUsd: '0.2', unknownCostCalls: 0,
      liveSessions: 1, deadSessions: 1, unknownLivenessSessions: 1, completeUsageRatio: 1, priceCoverageRatio: 1,
      cacheHitRate: { value: 0.8, state: 'complete' }, cacheHitRateIncludingKeepalive: { value: 0.8 }, tokens: { knownTokens: independentTokens } })
    const imported = parseLedgerExport(serializeLedger(data, 'jsonl'))
    expect(imported.rows).toHaveLength(data.rows.length)
    expect(imported.rows).toEqual(expect.arrayContaining(data.rows))
    expect(summarizeToday(imported, asOf, 10000)).toEqual(result)
    const verified = verifyLedger(data, asOf, 10000)
    expect(verified.valid).toBe(true)
    expect(verified.recomputed.tokens).toBe(210)
    expect(verified.summary.liveSessions).toBe([live].length)
    process.stderr.write(JSON.stringify({ fixture: 'midnight-and-keepalive',
      input: independentCalls.map(row => ({ startedAt: row.start.startedAt, usage: row.finish!.usage, costUsd: row.finish!.costUsd })),
      summary: result, recomputed: verified.recomputed }) + '\n')
  })
  it('retains missing amounts and partial buckets without claiming a computable hit rate', () => {
    const partial = call('partial'); delete partial.finish!.usage!.cacheReadTokens; partial.finish!.usageState = 'partial'
    partial.finish!.pricingState = 'partial-usage'; delete partial.finish!.costUsd
    const pending = call('pending'); delete pending.finish
    const result = summarizeToday(snapshot([partial, pending]), asOf, 10000)
    expect(result).toMatchObject({ unknownCostCalls: 2, completeUsageRatio: 0, priceCoverageRatio: 0, inFlightCalls: 1,
      cacheHitRate: { state: 'partial', value: undefined }, tokens: { knownTokens: 25 } })
    expect(summarizeToday(snapshot([]), asOf, 10000).cacheHitRate).toMatchObject({ state: 'unavailable', value: undefined })
    const zero = call('zero'); zero.finish!.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(summarizeToday(snapshot([zero]), asOf, 10000).cacheHitRate.state).toBe('unavailable')
  })
  it('filters every requested attribution, sorts deterministically and groups by seat, model and task', () => {
    const a = call('a'), b = call('b'); b.start.seat = 'seat-b'; b.start.taskId = 'task-b'; b.finish!.effectiveModel = 'model-b'
    b.start.nodeId = 'node-b' as typeof b.start.nodeId
    const data = snapshot([b, a])
    for (const groupBy of [['seat'], ['model'], ['taskId']] as const) expect(selectLedger(data, { groupBy }).groups).toHaveLength(2)
    expect(selectLedger(data, { groupBy: ['seat', 'model', 'taskId'] }).groups[0]!.keys).toEqual({ seat: 'seat-a', model: 'model-a', taskId: 'task-a' })
    expect(selectLedger(data, { from: midnight, to: asOf, seat: 'seat-a', window: 'window-a', taskId: 'task-a', model: 'model-a',
      sessionId: a.start.sessionId, nodeId: a.start.nodeId, purpose: 'conversation' }).snapshot.rows).toEqual([a])
    expect(selectLedger(data, { from: a.start.startedAt + 1 }).snapshot.rows).toEqual([])
    expect(selectLedger(data, { to: a.start.startedAt }).snapshot.rows).toEqual([])
    expect(() => selectLedger(data, { repriceVersion: 'other' })).toThrow('repricing')
  })
  it('keeps exact decimal sums beyond binary precision', () => {
    expect(sumUsd(['0.1', '0.2', '10000000000000000000.00000001'])).toBe('10000000000000000000.30000001')
    expect(sumUsd(['1.0', '9.0'])).toBe('10')
    expect(() => sumUsd(['NaN'])).toThrow()
  })
  it('uses only injected snapshots and exposes absent-ledger incompleteness', async () => {
    const ctx = new Context()
    new MemoryLedger(ctx, snapshot([call('one'), call('one')]))
    const service = new LedgerQueryService(ctx)
    expect((await service.today(asOf)).tokens.totalCalls).toBe(1)
    expect((await service.query({})).snapshot.rows).toHaveLength(1)
    const absent = new LedgerQueryService(new Context())
    expect((await absent.today(asOf)).complete).toBe(false)
  })
})

describe('live evidence and cache projections', () => {
  it('classifies stale remote, future, unverified and mismatched identities as unknown', () => {
    const local = run('local'), remote = run('remote', 'node-b'), future = run('future'), mismatch = run('mismatch'), unverified = run('unverified')
    unverified.start.processIdentity!.verification = 'unverified'
    const bad = observed(mismatch, 'confirmed'); if (bad.kind === 'process/observed') bad.identity = { ...bad.identity, startIdentity: 'other' }
    const data = snapshot([local, remote, future, mismatch, unverified,
      { kind: 'event', event: observed(local, 'confirmed') }, { kind: 'event', event: observed(remote, 'confirmed', asOf - 10001) },
      { kind: 'event', event: observed(future, 'confirmed', asOf + 1) }, { kind: 'event', event: bad }, { kind: 'event', event: observed(unverified, 'confirmed') }])
    expect(liveSessions(data, asOf, 10000)).toMatchObject({ confirmed: ['local'], unknown: ['future', 'mismatch', 'remote', 'unverified'], dead: [] })
    local.finish = { runId: local.start.runId, observedAt: asOf, endReason: 'completed', recovered: false, deliveryState: 'not-requested' }
    expect(liveSessions(data, asOf, 10000).confirmed).toEqual([])
  })
  it('deduplicates parent-side remote aliases and multiple residencies by session', () => {
    const a = run('a'), b = run('b'); a.start.remoteSessionId = b.start.sessionId
    const result = liveSessions(snapshot([a, b, { kind: 'event', event: observed(a, 'confirmed') }, { kind: 'event', event: observed(b, 'confirmed') }]), asOf, 10000)
    expect(result.confirmed).toEqual(['b'])
  })
  it('returns parent and descendant cache estimates, auto, unknown, and resets only on evidence', () => {
    const parent = run('parent'), child = run('child'), grandchild = run('grandchild'), missing = run('missing')
    child.start.parentSessionId = parent.start.sessionId
    grandchild.start.parentSessionId = child.start.sessionId
    missing.start.parentSessionId = parent.start.sessionId
    const evidence = (row: LedgerLifecycle, mode: 'explicit' | 'automatic', time: number): LedgerEvent => ({ ...observed(row, 'confirmed', time),
      kind: 'cache/evidence', evidence: { cacheMode: mode, breakReasons: [], ttlSeconds: 3600, lastCacheEvidenceAt: time } })
    const data = snapshot([parent, child, grandchild, missing, { kind: 'event', event: evidence(parent, 'explicit', asOf - 1000) },
      { kind: 'event', event: evidence(child, 'automatic', asOf - 1000) }, { kind: 'event', event: evidence(grandchild, 'explicit', asOf - 5000) }])
    expect(cacheRemaining(data, asOf, { sessionId: parent.start.sessionId, includeChildren: true })).toMatchObject([
      { sessionId: 'child', state: 'auto' }, { sessionId: 'grandchild', state: 'estimated', remainingSeconds: 3595 },
      { sessionId: 'missing', state: 'unknown' }, { sessionId: 'parent', state: 'estimated', remainingSeconds: 3599 }])
    const reset = snapshot([...data.rows, { kind: 'event', event: { ...evidence(parent, 'explicit', asOf), eventId: 'reset' as LedgerEvent['eventId'] } }])
    expect(cacheRemaining(reset, asOf, { sessionId: parent.start.sessionId })[0]!.remainingSeconds).toBe(3600)
    expect(cacheRemaining(data, asOf + 4000000, { sessionId: parent.start.sessionId })[0]!.remainingSeconds).toBe(0)
  })
})
