import { describe, expect, it } from 'vitest'
import { projectWaits, type LedgerCall, type LedgerLifecycle, type LedgerSnapshot, type LedgerRow } from '@panedesk/dsh-session-ledger'
import type { StatsRequest } from '../src/stats-types.ts'
import { summarizeStats } from '../src/stats.ts'

const midnight = Date.parse('2026-10-30T16:00:00Z')
const asOf = midnight + 3600000
function call(id: string, seat: string, taskId: string, startedAt: number, model = 'model-a'): LedgerCall {
  return { kind: 'call', start: {
    callId: id as LedgerCall['start']['callId'], runId: seat as LedgerCall['start']['runId'],
    logicalRequestId: id as LedgerCall['start']['logicalRequestId'], sessionId: seat as LedgerCall['start']['sessionId'],
    rootSessionId: seat as LedgerCall['start']['rootSessionId'], nodeId: 'local' as LedgerCall['start']['nodeId'],
    seat, window: `${seat}-window`, taskId, accountLabel: 'unknown', identitySource: 'startup',
    attemptIndex: 0, attemptVisibility: 'physical', provider: 'fixture', modelFamily: 'fixture', requestedModel: model,
    purpose: 'conversation', startedAt, cache: { cacheMode: 'explicit', breakReasons: [], prefixFingerprint: `prefix-${id}` },
    cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, priceVersion: 'fixture-v1', priceKey: model, referencePrice: true,
  }, finish: {
    callId: id as LedgerCall['start']['callId'], endedAt: startedAt + 1000, observedAt: startedAt + 1000,
    responseModelReported: 'same', effectiveModel: model, usageState: 'complete',
    usage: { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10, cacheWriteLongTokens: 4, outputTokens: 20 },
    costUsd: '0.1', pricingState: 'priced', wallMs: 1000, modelInFlightMs: 1000, queueMs: 0, backoffMs: 0,
    waits: [], compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false,
  } }
}
function run(id: string, parent?: string): LedgerLifecycle {
  const start = call(id, id, 'job-a', midnight - 10000).start
  return { kind: 'run', start: { ...start, ...(parent ? { parentSessionId: parent as typeof start.sessionId } : {}),
    launchState: 'started', deliveryPaths: [] }, liveness: 'unknown' }
}
function fixture(): LedgerSnapshot {
  const before = call('before', 'seat-a', 'job-a', midnight - 1)
  const a = call('a', 'seat-a', 'job-a', midnight)
  const b = call('b', 'seat-b', 'job-b', midnight + 1, 'model-b')
  const c = call('c', 'seat-c', 'job-a', midnight + 2)
  c.start.parentSessionId = a.start.sessionId
  const keepalive = call('maintenance', 'seat-a', 'job-a', midnight + 3)
  keepalive.start.purpose = 'keepalive'
  keepalive.finish!.usage = { inputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 10, cacheWriteLongTokens: 4, outputTokens: 20 }
  const ended = run('ended', 'seat-a')
  ended.finish = { runId: ended.start.runId, observedAt: midnight, endedAt: midnight, endReason: 'completed', recovered: false, deliveryState: 'not-requested' }
  return { asOf, complete: true, watermarks: {}, rows: [before, a, b, c, keepalive,
    run('parent'), run('child-a', 'parent'), run('child-b', 'parent'), ended] }
}

describe('five-tab ledger statistics', () => {
  it('concatenates stable cursor pages without dropping or repeating simultaneous calls', () => {
    const rows = ['z', 'A', 'a', 'b', 'c'].map(id => call(id, 'seat-a', 'job-a', midnight))
    rows[0]!.start.nodeId = 'remote' as LedgerCall['start']['nodeId']
    const data = { ...fixture(), rows }
    const request: StatsRequest = { range: 'all', bucket: 'hour', groupBy: 'seat' }
    const whole = summarizeStats(data, request, asOf)
    const first = summarizeStats(data, { ...request, details: { limit: 2 } }, asOf)
    expect(first.details).toHaveLength(2)
    expect(first.nextDetailCursor).not.toBeNull()
    const second = summarizeStats({ ...data, rows: [...rows].reverse() },
      { ...request, details: { limit: 2, after: first.nextDetailCursor! } }, asOf + 1000)
    const last = summarizeStats(data, { ...request, details: { limit: 2, after: second.nextDetailCursor! } }, asOf + 2000)
    expect([...first.details, ...second.details, ...last.details]).toEqual(whole.details)
    expect(last.details).toHaveLength(1)
    expect(last.nextDetailCursor).toBeNull()
    expect(second.asOf).toBe(asOf)
    expect(first.summary).toEqual(whole.summary)
    expect(whole.details.map(row => row.callId)).toEqual(['A', 'a', 'b', 'c', 'z'])
  })
  it('returns an empty cursor page and no continuation after the final key', () => {
    const row = call('only', 'seat-a', 'job-a', midnight)
    const result = summarizeStats({ ...fixture(), rows: [row] }, { range: 'all', bucket: 'hour', groupBy: 'seat',
      details: { limit: 2, after: { startedAt: midnight, nodeId: row.start.nodeId, callId: row.start.callId, asOf } } }, asOf)
    expect(result.details).toEqual([])
    expect(result.nextDetailCursor).toBeNull()
    expect(result.summary.calls).toBe(1)
  })
  it('reprojects late wait summaries at the exclusive historical observation instant', () => {
    const row = call('wait-owner', 'seat-a', 'job-a', midnight)
    const toolCallId = 'tool-a' as NonNullable<NonNullable<LedgerCall['finish']>['toolCallIds']>[number]
    row.finish!.toolCallIds = [toolCallId]
    const event: LedgerRow = { kind: 'event', event: { schemaVersion: 1,
      eventId: 'wait-late' as Extract<LedgerRow, { kind: 'event' }>['event']['eventId'],
      nodeId: row.start.nodeId, sessionId: row.start.sessionId, runId: row.start.runId, callId: row.start.callId,
      kind: 'wait/end', observedAt: asOf, interval: { kind: 'sleep', toolCallId, startedAt: midnight + 1000, endedAt: midnight + 2000, durationMs: 1000 } } }
    const data = { ...fixture(), rows: projectWaits([row, event]) }
    expect(summarizeStats(data, { range: 'all', bucket: 'hour', groupBy: 'seat' }, asOf).details[0]?.waits).toEqual({})
    expect(summarizeStats(data, { range: 'all', bucket: 'hour', groupBy: 'seat' }, asOf + 1).details[0]?.waits).toEqual({ sleep: { toolCalls: 1, durationMs: 1000 } })
  })
  it('uses a newer authoritative residency end without reviving an older unfinished residency', () => {
    const old = run('child', 'parent')
    const ended = run('child', 'parent')
    ended.start.runId = 'new-residency' as typeof ended.start.runId
    ended.start.startedAt = midnight
    ended.finish = { runId: ended.start.runId, observedAt: midnight + 1000, endedAt: midnight + 1000,
      endReason: 'completed', recovered: false, deliveryState: 'not-requested' }
    const request = { range: 'all', bucket: 'hour', groupBy: 'seat' } as const
    const data = { ...fixture(), rows: [old, ended] }
    const result = summarizeStats(data, request, asOf)
    expect(result.runningLanes.count).toBe(0)
    expect(result.runningWindows).toBe(0)
    expect(result.windows[0]?.running).toBe(false)
    const reopened = run('child', 'parent')
    reopened.start.runId = 'reopened' as typeof reopened.start.runId
    reopened.start.startedAt = midnight + 2000
    expect(summarizeStats({ ...data, rows: [...data.rows, reopened] }, request, asOf).runningLanes.count).toBe(1)
  })
  it('independently preserves the Beijing midnight half-open boundary', () => {
    const rows = [call('before', 'seat-a', 'job-a', midnight - 1), call('at', 'seat-a', 'job-a', midnight)]
    expect(summarizeStats({ ...fixture(), rows }, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf).summary.calls).toBe(1)
  })
  it('independently sums reference decimals without inventing missing prices', () => {
    const rows = [call('a', 'seat-a', 'job-a', midnight), call('b', 'seat-b', 'job-b', midnight)]
    rows[0]!.finish!.costUsd = '0.000001'
    const data = { ...fixture(), rows }
    const request = { range: 'all', bucket: 'hour', groupBy: 'seat' } as const
    expect(summarizeStats(data, request, asOf).summary.costUsd).toBe('0.100001')
    delete rows[1]!.finish!.costUsd
    expect(summarizeStats(data, request, asOf).summary.costUsd).toBeNull()
  })
  it('independently retains unknown usage instead of zero-filling call details', () => {
    const row = call('missing', 'seat-a', 'job-a', midnight)
    delete row.finish!.usage
    const result = summarizeStats({ ...fixture(), rows: [row] }, { range: 'all', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.details[0]?.tokens.outputTokens).toBeUndefined()
    expect(result.summary.usage.completeUsageCalls).toBe(0)
  })
  it('independently divides output by model-in-flight seconds rather than wall time', () => {
    const row = call('duration', 'seat-a', 'job-a', midnight)
    row.finish!.modelInFlightMs = 2000
    expect(summarizeStats({ ...fixture(), rows: [row] }, { range: 'all', bucket: 'hour', groupBy: 'model' }, asOf).models[0]?.outputTokensPerSecond).toBe(10)
  })
  it('independently excludes keepalive from cache hit rate while retaining its totals', () => {
    const result = summarizeStats(fixture(), { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.cacheHitRate.value).toBe(0.8)
    expect(result.keepalive.calls).toBe(1)
  })
  it('independently counts child sessions once without counting root sessions', () => {
    const child = run('child', 'parent')
    const result = summarizeStats({ ...fixture(), rows: [child, child, run('root')] }, { range: 'all', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.runningLanes.count).toBe(1)
  })
  it('independently retains one physical call per row and unknown prefix evidence', () => {
    const rows = [call('one', 'seat-a', 'job-a', midnight), call('two', 'seat-a', 'job-a', midnight)]
    rows[1]!.start.logicalRequestId = rows[0]!.start.logicalRequestId
    delete rows[0]!.start.cache.prefixFingerprint
    const result = summarizeStats({ ...fixture(), rows }, { range: 'all', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.details).toHaveLength(2)
    expect(result.details[0]?.prefixFingerprint).toBeNull()
    expect(result.details[1]?.prefixFingerprint).toBe('prefix-two')
  })
  it.each(['seat', 'taskId'] as const)('independently filters and groups %s attribution', (dimension) => {
    const filter = dimension === 'seat' ? { seat: 'seat-b' } : { taskId: 'job-b' }
    const result = summarizeStats(fixture(), { range: 'today', bucket: 'day', groupBy: dimension, ...filter }, asOf)
    expect(result.groups.map(row => [row.key, row.calls])).toEqual([[dimension === 'seat' ? 'seat-b' : 'job-b', 1]])
  })
  it('independently preserves model totals and Beijing day buckets', () => {
    const result = summarizeStats(fixture(), { range: 'today', bucket: 'day', groupBy: 'model' }, asOf)
    expect(result.models.map(row => [row.key, row.calls])).toEqual([['model-a', 3], ['model-b', 1]])
    expect(result.buckets.every(row => row.startedAt === midnight)).toBe(true)
  })
  it('independently retains short and long cache-write tokens and window attribution', () => {
    const result = summarizeStats(fixture(), { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.details[0]?.tokens).toMatchObject({ cacheWriteShortTokens: 6, cacheWriteLongTokens: 4 })
    expect(result.windows.find(row => row.sessionId === 'seat-b')).toMatchObject({ seat: 'seat-b', taskIds: ['job-b'] })
  })
  it('independently preserves overview token and running-window totals', () => {
    const result = summarizeStats(fixture(), { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.summary.usage.knownTokens).toBe(480)
    expect(result.runningWindows).toBe(3)
    expect(result.alerts).toBe(0)
    expect(result.queryMs).toBeGreaterThanOrEqual(0)
  })
  it('recomputes overview, seat/task/model groups, buckets, throughput and call rows from three seats and two tasks', () => {
    const data = fixture()
    const result = summarizeStats(data, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.from).toBe(midnight)
    expect(result.summary).toMatchObject({ calls: 4, costUsd: '0.4', usage: { knownTokens: 480 }, outputTokensPerSecond: 20 })
    expect(result.cacheHitRate).toMatchObject({ value: 0.8, state: 'complete' })
    expect(result.keepalive).toMatchObject({ calls: 1, costUsd: '0.1' })
    expect(result.runningLanes).toEqual({ count: 2, unknownSessions: 0, complete: true, bySeat: [{ seat: 'child-a', count: 1 }, { seat: 'child-b', count: 1 }] })
    expect(result.groups.map(group => [group.key, group.calls])).toEqual([['seat-a', 2], ['seat-b', 1], ['seat-c', 1]])
    expect(result.models.map(group => [group.key, group.calls, group.costUsd])).toEqual([['model-a', 3, '0.3'], ['model-b', 1, '0.1']])
    expect(result.buckets).toHaveLength(2)
    expect(result.details.map(row => row.callId)).toEqual(['a', 'b', 'c', 'maintenance'])
    expect(result.details[0]).toMatchObject({ prefixFingerprint: 'prefix-a', priceVersion: 'fixture-v1', tokens: { cacheWriteShortTokens: 6, cacheWriteLongTokens: 4 } })
    expect(result.windows.find(row => row.sessionId === 'seat-c')).toMatchObject({ seat: 'seat-c', taskIds: ['job-a'] })
    const tasks = summarizeStats(data, { range: 'today', bucket: 'day', groupBy: 'taskId' }, asOf)
    expect(tasks.groups.map(group => [group.key, group.calls])).toEqual([['job-a', 3], ['job-b', 1]])
    expect(tasks.buckets).toHaveLength(2)
    process.stderr.write(JSON.stringify({ fixture: 'three-seats-two-tasks-subagents', independent: { calls: 4, tokens: 4 * 120, usd: '0.4', cacheHitRate: 240 / 300, runningLanes: 2, outputTokensPerSecond: 80 / 4 }, result }) + '\n')
  })
  it('recomputes a second day fixture with nonuniform durations, exact reference decimals and a seat filter', () => {
    const rows = [call('x', 'seat-a', 'job-a', midnight), call('y', 'seat-b', 'job-b', midnight + 3600000, 'model-b'), call('z', 'seat-c', 'job-a', midnight + 7200000)]
    rows[0]!.finish!.costUsd = '0.000001'
    rows[1]!.finish!.costUsd = '0.2'
    rows[2]!.finish!.costUsd = '0.03'
    rows[1]!.finish!.modelInFlightMs = 2000
    rows[2]!.finish!.modelInFlightMs = 3000
    const now = midnight + 10800000
    const result = summarizeStats({ asOf: now, complete: true, watermarks: {}, rows: [...rows, run('child', 'parent')] }, { range: 'today', bucket: 'hour', groupBy: 'taskId' }, now)
    expect(result.summary).toMatchObject({ calls: 3, costUsd: '0.230001', usage: { knownTokens: 360 }, outputTokensPerSecond: 10 })
    expect(result.groups.map(row => [row.key, row.calls])).toEqual([['job-a', 2], ['job-b', 1]])
    expect(result.models.map(row => [row.key, row.outputTokensPerSecond])).toEqual([['model-a', 10], ['model-b', 10]])
    expect(result.buckets.map(row => row.startedAt)).toEqual([midnight, midnight + 3600000, midnight + 7200000])
    expect(result.details.map(row => row.costUsd)).toEqual(['0.000001', '0.2', '0.03'])
    expect(result.runningLanes.count).toBe(1)
    const seat = summarizeStats({ asOf: now, complete: true, watermarks: {}, rows }, { range: 'today', bucket: 'day', groupBy: 'seat', seat: 'seat-b' }, now)
    expect(seat.summary).toMatchObject({ calls: 1, costUsd: '0.2', outputTokensPerSecond: 10 })
    expect(seat.windows[0]).toMatchObject({ seat: 'seat-b', taskIds: ['job-b'] })
    process.stderr.write(JSON.stringify({ fixture: 'three-hour-nonuniform-durations', independent: { calls: 3, tokens: 360, usd: '0.230001', outputTokensPerSecond: 60 / 6, runningLanes: 1 }, summary: result.summary, groups: result.groups, models: result.models, buckets: result.buckets, details: result.details }) + '\n')
  })
  it.each(['6h', '24h', '72h', '168h', 'all'] as const)('selects the documented rolling range %s', (range) => {
    const result = summarizeStats(fixture(), { range, bucket: 'hour', groupBy: 'model' }, asOf)
    expect(result.summary.calls).toBe(5)
    expect(result.from).toBe(range === 'all' ? null : asOf - Number.parseInt(range) * 3600000)
  })
  it('keeps missing usage, price, throughput and fingerprints unknown rather than zero', () => {
    const pending = call('pending', 'seat-a', 'job-a', midnight)
    delete pending.finish
    delete pending.start.cache.prefixFingerprint
    const result = summarizeStats({ asOf, complete: false, rows: [pending], watermarks: {} }, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.summary).toMatchObject({ costUsd: null, unknownCostCalls: 1, outputTokensPerSecond: null,
      usage: { totalCalls: 1, completeUsageCalls: 0 } })
    expect(result.details[0]).toMatchObject({ endedAt: null, prefixFingerprint: null, costUsd: null,
      outputTokensPerSecond: null, waits: null, responseModelReported: null })
    expect(result.runningLanes.count).toBeNull()
    expect(result.cacheHitRate.value).toBeUndefined()
  })
  it('does not reveal future completions and includes unfinished windows without calls', () => {
    const pending = call('future-end', 'seat-a', 'job-a', asOf - 100)
    const child = run('quiet-child', 'parent')
    child.finish = { runId: child.start.runId, observedAt: asOf + 100, endedAt: asOf + 100, endReason: 'completed', recovered: false, deliveryState: 'not-requested' }
    const boundary = run('boundary', 'parent')
    boundary.start.startedAt = asOf
    const result = summarizeStats({ asOf: asOf + 1000, complete: true, watermarks: {}, rows: [pending, child, boundary] }, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(result.details[0]).toMatchObject({ endedAt: null, costUsd: null, outputTokensPerSecond: null })
    expect(result.runningLanes.count).toBe(1)
    expect(result.runningWindows).toBe(1)
    expect(result.windows.find(row => row.sessionId === 'quiet-child')).toMatchObject({ calls: 0, running: true, taskIds: ['job-a'] })
    expect(result.windows.some(row => row.sessionId === 'boundary')).toBe(false)
  })
  it('keeps incomplete cache evidence and model-filtered alerts unknown', () => {
    const source = fixture()
    const partial = summarizeStats({ ...source, complete: false }, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf)
    expect(partial.cacheHitRate).toMatchObject({ state: 'partial', value: undefined })
    const filtered = summarizeStats(source, { range: 'today', bucket: 'day', groupBy: 'model', model: 'model-a' }, asOf)
    expect(filtered.alerts).toBeNull()
    expect(filtered.summary).toMatchObject({ calls: 3, costUsd: '0.3' })
  })
  it('deduplicates residencies and remote aliases, and retains unresolved remote backfill as unknown', () => {
    const child = run('child', 'parent'), alias = run('alias', 'parent'), missing = run('missing', 'parent')
    alias.start.remoteSessionId = child.start.sessionId
    missing.start.remoteSessionId = 'not-backfilled' as typeof child.start.sessionId
    const result = summarizeStats({ asOf, complete: true, watermarks: {}, rows: [child, child, alias, missing, run('root')] }, { range: 'today', bucket: 'day', groupBy: 'seat' }, asOf)
    expect(result.runningLanes).toMatchObject({ count: null, unknownSessions: 1, complete: false })
    expect(result.runningLanes.bySeat).toEqual([{ seat: 'child', count: 1 }])
    expect(result.runningWindows).toBeNull()
    const byAlias = summarizeStats({ asOf, complete: true, watermarks: {}, rows: [child, alias] },
      { range: 'today', bucket: 'day', groupBy: 'seat', seat: 'alias' }, asOf)
    expect(byAlias.runningLanes).toMatchObject({ count: 1, unknownSessions: 0, complete: true })
    expect(byAlias.runningWindows).toBe(1)
    expect(byAlias.windows.map(row => row.sessionId)).toEqual(['child'])
  })
})
