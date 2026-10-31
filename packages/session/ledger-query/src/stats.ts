/** Statistics over public ledger projections, without transcript reads or ledger writes. */
import { projectWaits, type LedgerCall, type LedgerLifecycle, type LedgerRow, type LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { hitRate, selectLedger, sumUsd, tokenColumns, usageTotals } from './query.ts'
import type { StatsAggregate, StatsCallDetail, StatsRequest, StatsRunningLanes, StatsView } from './stats-types.ts'

function aggregate(key: string, calls: readonly LedgerCall[]): StatsAggregate {
  const priced = calls.flatMap(call => call.finish?.pricingState === 'priced' && call.finish.costUsd !== undefined ? [call.finish.costUsd] : [])
  const timed = calls.every(call => call.finish !== undefined)
  const duration = timed ? calls.reduce((sum, call) => sum + (call.finish?.modelInFlightMs ?? 0), 0) : null
  const outputKnown = calls.every(call => call.finish?.usage?.outputTokens !== undefined)
  const usage = usageTotals(calls)
  return { key, calls: calls.length, usage, costUsd: priced.length === calls.length ? sumUsd(priced) : null,
    unknownCostCalls: calls.length - priced.length, modelInFlightMs: duration,
    outputTokensPerSecond: duration !== null && duration > 0 && outputKnown ? (usage.outputTokens ?? 0) * 1000 / duration : null }
}
function groups(calls: readonly LedgerCall[], keyOf: (call: LedgerCall) => string): StatsAggregate[] {
  const selected = new Map<string, LedgerCall[]>()
  for (const call of calls) {
    const key = keyOf(call), items = selected.get(key)
    if (items) items.push(call)
    else selected.set(key, [call])
  }
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => aggregate(key, items))
}
function matches(run: LedgerLifecycle, request: StatsRequest): boolean {
  return (request.seat === undefined || request.seat === run.start.seat)
    && (request.taskId === undefined || request.taskId === run.start.taskId)
    && (request.model === undefined || request.model === run.start.effectiveModel)
}
function sessionRuns(runs: readonly LedgerLifecycle[], request: StatsRequest) {
  const owners = new Map<LedgerLifecycle['start']['sessionId'], LedgerLifecycle[]>()
  for (const run of runs) {
    if (run.start.remoteSessionId) continue
    const items = owners.get(run.start.sessionId)
    if (items) items.push(run)
    else owners.set(run.start.sessionId, [run])
  }
  const aliases = runs.filter(run => run.start.remoteSessionId !== undefined)
  const sessions = [...owners].filter(([id, items]) => items.some(run => matches(run, request))
    || aliases.some(run => run.start.remoteSessionId === id && matches(run, request)))
  const unresolved = aliases.filter(run => run.start.remoteSessionId !== undefined
    && !owners.has(run.start.remoteSessionId) && !run.finish && matches(run, request))
  return { sessions, unresolved }
}
function unfinishedRuns(runs: readonly LedgerLifecycle[]): LedgerLifecycle[] {
  const endedThrough = Math.max(-Infinity, ...runs.flatMap(run => run.finish ? [run.start.startedAt] : []))
  return runs.filter(run => !run.finish && run.start.startedAt > endedThrough)
}
function compareDetails(a: LedgerCall['start'], b: Pick<LedgerCall['start'], 'startedAt' | 'nodeId' | 'callId'>): number {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
  return a.startedAt - b.startedAt || compare(a.nodeId, b.nodeId) || compare(a.callId, b.callId)
}
function runningLanes(source: LedgerSnapshot, request: StatsRequest): StatsRunningLanes {
  const runs = source.rows.filter((row): row is LedgerLifecycle => row.kind === 'run')
  const { sessions, unresolved } = sessionRuns(runs, request)
  const pending = sessions.flatMap(([, items]) => {
    const child = unfinishedRuns(items).find(run => run.start.parentSessionId)
    return child ? [child] : []
  })
  const unknown = new Set(unresolved.filter(run => run.start.parentSessionId).map(run => run.start.remoteSessionId))
  const bySeat = new Map<string, number>()
  for (const row of pending) bySeat.set(row.start.seat, (bySeat.get(row.start.seat) ?? 0) + 1)
  const complete = source.complete && unknown.size === 0
  return { count: complete ? pending.length : null, unknownSessions: unknown.size, complete,
    bySeat: [...bySeat].sort(([a], [b]) => a.localeCompare(b)).map(([seat, count]) => ({ seat, count })) }
}
function atInstant(source: LedgerSnapshot, asOf: number): LedgerSnapshot {
  return { ...source, rows: projectWaits(source.rows.flatMap<LedgerRow>((row) => {
    if (row.kind === 'event') return row.event.observedAt < asOf ? [row] : []
    if (row.start.startedAt >= asOf) return []
    if (row.finish && row.finish.observedAt >= asOf) {
      if (row.kind === 'call') return [{ kind: 'call', start: row.start }]
      return [{ kind: 'run', start: row.start, liveness: 'unknown' }]
    }
    return [row]
  })) }
}
function detail(call: LedgerCall): StatsCallDetail {
  const finish = call.finish, totals = aggregate('', [call])
  return { callId: call.start.callId, sessionId: call.start.sessionId, parentSessionId: call.start.parentSessionId ?? null,
    seat: call.start.seat, window: call.start.window, taskId: call.start.taskId ?? null,
    model: finish?.effectiveModel ?? call.start.requestedModel, responseModelReported: finish?.responseModelReported ?? null,
    purpose: call.start.purpose,
    tokens: tokenColumns(call), usageState: finish?.usageState ?? 'unknown', costUsd: totals.costUsd,
    priceVersion: finish?.priceVersion ?? (finish?.pricingState === 'priced' ? call.start.priceVersion : null),
    startedAt: call.start.startedAt, endedAt: finish?.endedAt ?? null, wallMs: finish?.wallMs ?? null,
    modelInFlightMs: finish?.modelInFlightMs ?? null, waits: call.waitSummary?.categories ?? null,
    peakContextTokens: finish?.peakContextTokens ?? null, compactionCount: finish?.compactionCount ?? null,
    compactionTimes: finish?.compactionTimes ?? null, endReason: finish?.endReason ?? null,
    prefixFingerprint: (finish?.cache ?? call.start.cache).prefixFingerprint ?? null,
    outputTokensPerSecond: totals.outputTokensPerSecond }
}
/** Compute all five statistics tabs from one public, already-authorized snapshot.
 * @param source - Deduplicated ledger projection; incomplete scans remain visibly incomplete.
 * @param request - Fixed time range, grouping, bucket size and optional attribution filters.
 * @param asOf - Exclusive observation instant in UTC milliseconds.
 * @returns Call-only totals, child-session lifecycle counts and explicit unknown evidence.
 */
export function summarizeStats(source: LedgerSnapshot, request: StatsRequest, asOf: number): StatsView {
  const started = performance.now()
  asOf = request.details?.after?.asOf ?? asOf
  if (request.details && (!Number.isSafeInteger(request.details.limit) || request.details.limit <= 0)) {
    throw new Error('Statistics detail limit must be a positive safe integer')
  }
  const from = request.range === 'today'
    ? Math.floor((asOf + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
    : request.range === 'all' ? null : asOf - Number.parseInt(request.range) * 3600000
  const observed = atInstant(source, asOf)
  const selected = selectLedger(observed, { ...(from === null ? {} : { from }), to: asOf,
    ...(request.seat === undefined ? {} : { seat: request.seat }), ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.model === undefined ? {} : { model: request.model }) }).snapshot
  const calls = selected.rows.filter((row): row is LedgerCall => row.kind === 'call')
  const allRuns = observed.rows.filter((row): row is LedgerLifecycle => row.kind === 'run')
  const definitions = new Map(allRuns.map(row => [row.start.runId, row.start.definition ?? '']))
  const modelOf = (call: LedgerCall) => call.finish?.effectiveModel ?? call.start.requestedModel
  const by = (call: LedgerCall): string => {
    switch (request.groupBy) {
      case 'seat': return call.start.seat
      case 'window': return call.start.window
      case 'taskId': return call.start.taskId ?? ''
      case 'model': return modelOf(call)
      case 'role': return call.start.parentSessionId ? 'child' : 'root'
      case 'definition': return definitions.get(call.start.runId) ?? ''
    }
  }
  const interval = request.bucket === 'hour' ? 3600000 : 86400000
  const bucketOf = (call: LedgerCall) => Math.floor((call.start.startedAt + 8 * 3600000) / interval) * interval - 8 * 3600000
  const bucketMetadata = new Map(calls.map(call => [JSON.stringify([bucketOf(call), modelOf(call)]),
    { startedAt: bucketOf(call), model: modelOf(call) }]))
  const buckets = groups(calls, call => JSON.stringify([bucketOf(call), modelOf(call)])).map((group) => {
    const metadata = bucketMetadata.get(group.key)
    if (!metadata) throw new Error('Statistics bucket metadata is missing')
    return { ...group, ...metadata }
  }).sort((a, b) => a.startedAt - b.startedAt || a.model.localeCompare(b.model))
  const sessionCalls = new Map<LedgerCall['start']['sessionId'], LedgerCall[]>()
  for (const call of calls) {
    const items = sessionCalls.get(call.start.sessionId)
    if (items) items.push(call)
    else sessionCalls.set(call.start.sessionId, [call])
  }
  const { sessions, unresolved } = sessionRuns(allRuns, request)
  const visibleSessions = new Map(sessions)
  for (const [sessionId, runs] of sessions) {
    if (runs.some(run => !run.finish || from === null || run.start.startedAt >= from) && !sessionCalls.has(sessionId)) {
      sessionCalls.set(sessionId, [])
    }
  }
  const windows = [...sessionCalls].sort(([a], [b]) => a.localeCompare(b)).map(([sessionId, items]) => {
    const runs = visibleSessions.get(sessionId) ?? []
    const start = items[0]?.start ?? runs[0]?.start
    if (!start) throw new Error('Statistics window has neither calls nor lifecycle evidence')
    return { ...aggregate(sessionId, items), sessionId, seat: start.seat, window: start.window,
      taskIds: [...new Set([...items, ...runs].flatMap(row => row.start.taskId === undefined ? [] : [row.start.taskId]))].sort(),
      parentSessionId: start.parentSessionId ?? null, running: runs.length ? unfinishedRuns(runs).length > 0 : null }
  })
  const cacheCalls = calls.filter(call => call.start.purpose !== 'keepalive')
  const observedHitRate = hitRate(cacheCalls)
  const cacheHitRate = source.complete ? observedHitRate : { ...observedHitRate, state: 'partial' as const, value: undefined }
  const after = request.details?.after
  const ordered = [...calls].sort((a, b) => compareDetails(a.start, b.start))
  const remaining = after ? ordered.filter(call => compareDetails(call.start, after) > 0) : ordered
  const page = remaining.slice(0, request.details?.limit)
  const last = page.at(-1)?.start
  const nextDetailCursor = last && page.length < remaining.length
    ? { startedAt: last.startedAt, nodeId: last.nodeId, callId: last.callId, asOf } : null
  return { asOf, from, complete: source.complete, queryMs: performance.now() - started,
    summary: aggregate('total', calls), keepalive: aggregate('keepalive', calls.filter(call => call.start.purpose === 'keepalive')),
    cacheHitRate, runningLanes: runningLanes(observed, request),
    runningWindows: source.complete && unresolved.length === 0
      ? sessions.filter(([, runs]) => unfinishedRuns(runs).length > 0).length : null,
    alerts: source.complete && request.model === undefined ? selected.rows.filter(row => row.kind === 'event' && row.event.kind === 'alert').length : null,
    projects: groups(calls, call => call.start.seat), windows, groups: groups(calls, by), models: groups(calls, modelOf),
    buckets, details: page.map(detail), nextDetailCursor }
}
