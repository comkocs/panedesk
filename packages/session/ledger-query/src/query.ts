/** Pure selection and coverage-aware projections over public ledger snapshots. */
import type { LedgerCall, LedgerLifecycle, LedgerRow, LedgerSnapshot, LedgerTokenColumns } from '@panedesk/dsh-session-ledger'
import type { LedgerCacheEvidence } from '@panedesk/dsh-session-ledger'
import type { LedgerGroupBy, LedgerHitRate, LedgerQueryOptions, LedgerQueryResult, LedgerTodaySummary, LedgerUsageTotals } from './types.ts'

/** Exact nonnegative decimal addition without binary floating-point rounding.
 * @param values - USD decimal strings from priced calls.
 * @returns normalized decimal sum.
 */
export function sumUsd(values: readonly string[]): string {
  const parts = values.map((value) => {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid ledger decimal amount')
    return value.split('.')
  })
  const scale = Math.max(0, ...parts.map(part => (part[1] ?? '').length))
  const total = parts.reduce((sum, [whole, fraction = '']) => sum + BigInt((whole ?? '0') + fraction.padEnd(scale, '0')), 0n)
  if (!scale) return String(total)
  const text = String(total).padStart(scale + 1, '0')
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '') || '0'
}

/** Stable business-time ordering, independent of import order.
 * @param row - projected ledger row.
 * @returns comparable time, node, call and tie-break identity.
 */
export function rowOrder(row: LedgerRow): readonly [number, string, string, string] {
  return row.kind === 'event'
    ? [row.event.observedAt, row.event.nodeId, row.event.callId ?? '', row.event.eventId]
    : [row.start.startedAt, row.start.nodeId, row.kind === 'call' ? row.start.callId : '', row.start.runId]
}

/** Sort snapshots without changing the input array.
 * @param rows - source projections.
 * @returns deterministic sorted copy.
 */
export function sortRows(rows: readonly LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) => {
    const x = rowOrder(a), y = rowOrder(b)
    return x[0] - y[0] || compare(x[1], y[1]) || compare(x[2], y[2]) || compare(x[3], y[3]) || compare(a.kind, b.kind)
  })
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

/** Disjoint token columns retain missing evidence and actual tier names.
 * @param call - public projected call.
 * @returns five buckets plus the original total-write bucket.
 */
export function tokenColumns(call: LedgerCall): LedgerTokenColumns {
  const usage = call.finish?.usage
  const tiering = call.finish?.cacheWriteTiering ?? call.start.cacheWriteTiering
  return {
    ...usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens },
    ...usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens },
    ...usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
    ...tiering.kind === 'tiered' && usage?.cacheWriteLongTokens !== undefined
      ? { cacheWriteLongTokens: usage.cacheWriteLongTokens } : {},
    ...tiering.kind === 'tiered' && usage?.cacheWriteTokens !== undefined && usage.cacheWriteLongTokens !== undefined
      ? { cacheWriteShortTokens: usage.cacheWriteTokens - usage.cacheWriteLongTokens } : {},
    cacheWriteTiering: tiering,
  }
}
function completeUsage(call: LedgerCall): boolean {
  const u = call.finish?.usage
  return call.finish?.usageState === 'complete' && u !== undefined && u.cacheReadTokens !== undefined && u.cacheWriteTokens !== undefined
}
/** Sum only observed buckets; missing calls remain visible in coverage.
 * @param calls - unique selected calls.
 * @returns observed totals and explicit completeness counts.
 */
export function usageTotals(calls: readonly LedgerCall[]): LedgerUsageTotals {
  const columns = calls.map(tokenColumns)
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheWriteShortTokens' | 'cacheWriteLongTokens') => {
    const known = columns.flatMap(column => column[key] === undefined ? [] : [column[key]])
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined
  }
  const inputTokens = sum('inputTokens'), outputTokens = sum('outputTokens')
  const cacheReadTokens = sum('cacheReadTokens'), cacheWriteTokens = sum('cacheWriteTokens')
  const tier = columns[0]?.cacheWriteTiering
  const sameTier = tier !== undefined && columns.every(column => JSON.stringify(column.cacheWriteTiering) === JSON.stringify(tier))
  const cacheWriteShortTokens = sameTier ? sum('cacheWriteShortTokens') : undefined
  const cacheWriteLongTokens = sameTier ? sum('cacheWriteLongTokens') : undefined
  return {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...cacheWriteShortTokens === undefined ? {} : { cacheWriteShortTokens },
    ...cacheWriteLongTokens === undefined ? {} : { cacheWriteLongTokens },
    cacheWriteTiering: sameTier ? tier : { kind: 'unknown' },
    knownTokens: (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    completeUsageCalls: calls.filter(completeUsage).length, totalCalls: calls.length,
  }
}
/** Compute cache-read share without inventing missing input evidence.
 * @param calls - Selected unique physical calls, with maintenance selection owned by the caller.
 * @returns Observed numerator and denominator, and a value only for complete nonempty evidence.
 */
export function hitRate(calls: readonly LedgerCall[]): LedgerHitRate {
  const totals = usageTotals(calls)
  const cacheReadTokens = totals.cacheReadTokens ?? 0
  const inputTokensIncludingCache = (totals.inputTokens ?? 0) + cacheReadTokens + (totals.cacheWriteTokens ?? 0)
  const state = totals.completeUsageCalls !== calls.length ? 'partial' : inputTokensIncludingCache === 0 ? 'unavailable' : 'complete'
  return { state, value: state === 'complete' ? cacheReadTokens / inputTokensIncludingCache : undefined, cacheReadTokens, inputTokensIncludingCache }
}
function amount(call: LedgerCall): string | undefined {
  return call.finish?.pricingState === 'priced' ? call.finish.costUsd : undefined
}
function keyOf(call: LedgerCall, key: LedgerGroupBy): string {
  if (key === 'model') return call.finish?.effectiveModel ?? call.start.requestedModel
  return call.start[key] ?? ''
}

/** Select rows using start-time ownership and transitive session linkage.
 * @param source - complete service snapshot, not a private journal format.
 * @param options - half-open filters and grouping dimensions.
 * @returns filtered snapshot and call-only grouped totals.
 */
export function selectLedger(source: LedgerSnapshot, options: LedgerQueryOptions): LedgerQueryResult {
  if (options.repriceVersion !== undefined) throw new Error('Historical repricing is not available in the query service')
  const sessions = new Set<string>(options.sessionId === undefined ? [] : [options.sessionId])
  if (options.includeChildren && options.sessionId !== undefined) {
    const children = new Map<string, Set<string>>()
    for (const row of source.rows) {
      if (row.kind === 'event' || !row.start.parentSessionId) continue
      const entries = children.get(row.start.parentSessionId) ?? new Set<string>()
      entries.add(row.start.sessionId)
      children.set(row.start.parentSessionId, entries)
    }
    for (const session of sessions) for (const child of children.get(session) ?? []) sessions.add(child)
  }
  const owners = new Map(source.rows.filter(row => row.kind !== 'event').map(row => [row.start.runId, row.start]))
  const rows = sortRows(source.rows.filter((row) => {
    const time = rowOrder(row)[0]
    if (options.from !== undefined && time < options.from || options.to !== undefined && time >= options.to) return false
    const context = row.kind === 'event' ? owners.get(row.event.runId) : row.start
    const nodeId = row.kind === 'event' ? row.event.nodeId : row.start.nodeId
    const sessionId = row.kind === 'event' ? row.event.sessionId : row.start.sessionId
    if (options.nodeId !== undefined && nodeId !== options.nodeId) return false
    if (options.sessionId !== undefined && !sessions.has(sessionId)) return false
    for (const key of ['seat', 'window', 'taskId', 'accountLabel'] as const) {
      if (options[key] !== undefined && context?.[key] !== options[key]) return false
    }
    if (options.model !== undefined && (row.kind === 'call' ? keyOf(row, 'model') : row.kind === 'run' ? row.start.effectiveModel : undefined) !== options.model) return false
    if (options.modelFamily !== undefined && (row.kind !== 'call' || row.start.modelFamily !== options.modelFamily)) return false
    if (options.purpose !== undefined && (row.kind !== 'call' || row.start.purpose !== options.purpose)) return false
    return true
  }))
  const groups = new Map<string, { keys: Partial<Record<LedgerGroupBy, string>>; calls: LedgerCall[] }>()
  for (const row of rows) {
    if (row.kind !== 'call') continue
    const keys = Object.fromEntries((options.groupBy ?? []).map(key => [key, keyOf(row, key)]))
    const id = JSON.stringify(keys)
    let group = groups.get(id)
    if (!group) { group = { keys, calls: [] }; groups.set(id, group) }
    group.calls.push(row)
  }
  return { snapshot: { ...source, rows }, groups: [...groups.values()].map(({ keys, calls }) => ({
    keys, costUsd: sumUsd(calls.flatMap(call => amount(call) === undefined ? [] : [amount(call) ?? '0'])),
    unknownCostCalls: calls.filter(call => amount(call) === undefined).length, usage: usageTotals(calls),
  })) }
}

/** Liveness counts are unique sessions, not residency or parent-side aliases. */
export interface LedgerLiveResult {
  confirmed: readonly string[]
  unknown: readonly string[]
  dead: readonly string[]
  nodeObservedAt: Readonly<Record<string, number>>
}
/** Require fresh observations tied to the exact registered process identity.
 * @param snapshot - public projected rows and process observations.
 * @param asOf - query wall-clock instant.
 * @param freshnessMs - maximum accepted observation age.
 * @returns disjoint session classifications; ended runs are excluded.
 */
export function liveSessions(snapshot: LedgerSnapshot, asOf: number, freshnessMs: number): LedgerLiveResult {
  const states = new Map<string, 'confirmed' | 'unknown' | 'dead'>()
  const nodeObservedAt: Record<string, number> = {}
  const observations = new Map<string, Extract<Extract<LedgerRow, { kind: 'event' }>['event'], { kind: 'process/observed' }>>()
  for (const row of snapshot.rows) {
    if (row.kind !== 'event' || row.event.kind !== 'process/observed' || row.event.observedAt > asOf) continue
    const key = JSON.stringify([row.event.nodeId, row.event.runId])
    const previous = observations.get(key)
    if (!previous || row.event.observedAt > previous.observedAt) observations.set(key, row.event)
  }
  for (const row of snapshot.rows) {
    if (row.kind !== 'run' || row.finish || row.start.startedAt > asOf) continue
    const identity = row.start.processIdentity
    let state: LedgerLifecycle['liveness'] = 'unknown'
    const latest = observations.get(JSON.stringify([row.start.nodeId, row.start.runId]))
    const event = latest && latest.observedAt >= row.start.startedAt ? latest : undefined
    if (row.start.launchState === 'started' && event && identity && identity.nodeId === row.start.nodeId && event.identity.nodeId === identity.nodeId
      && event.identity.pid === identity.pid && event.identity.startIdentity === identity.startIdentity
      && event.identity.bootIdentity === identity.bootIdentity && identity.startIdentity && identity.bootIdentity
      && identity.verification === 'verified' && event.identity.verification === 'verified') {
      nodeObservedAt[event.nodeId] = Math.max(nodeObservedAt[event.nodeId] ?? 0, event.observedAt)
      if (asOf - event.observedAt <= freshnessMs) state = event.liveness
    }
    const session = row.start.remoteSessionId ?? row.start.sessionId
    const previous = states.get(session)
    if (previous === undefined || state === 'confirmed' || previous === 'dead' && state === 'unknown') states.set(session, state)
  }
  const entries = [...states.entries()].sort(([a], [b]) => compare(a, b))
  return { confirmed: entries.filter(([, state]) => state === 'confirmed').map(([id]) => id),
    unknown: entries.filter(([, state]) => state === 'unknown').map(([id]) => id),
    dead: entries.filter(([, state]) => state === 'dead').map(([id]) => id), nodeObservedAt }
}

/** Compute Beijing-day overview from call starts, keeping all-node live evidence.
 * @param snapshot - source snapshot at a known watermark.
 * @param asOf - exclusive observation instant.
 * @param freshnessMs - accepted process-observation age.
 * @returns four headline values with coverage and missing-evidence counts.
 */
export function summarizeToday(snapshot: LedgerSnapshot, asOf: number, freshnessMs: number): LedgerTodaySummary {
  const from = Math.floor((asOf + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  const calls = selectLedger(snapshot, { from, to: asOf }).snapshot.rows.filter((row): row is LedgerCall => row.kind === 'call')
  const tokens = usageTotals(calls), live = liveSessions(snapshot, asOf, freshnessMs)
  const priced = calls.flatMap(call => amount(call) === undefined ? [] : [amount(call) ?? '0'])
  return { from, asOf, timezone: 'Asia/Shanghai', costUsd: sumUsd(priced),
    keepaliveCostUsd: sumUsd(calls.flatMap(call => call.start.purpose === 'keepalive' && amount(call) !== undefined ? [amount(call) ?? '0'] : [])),
    unknownCostCalls: calls.length - priced.length, tokens, cacheHitRate: hitRate(calls.filter(call => call.start.purpose !== 'keepalive')),
    cacheHitRateIncludingKeepalive: hitRate(calls), liveSessions: live.confirmed.length,
    unknownLivenessSessions: live.unknown.length, deadSessions: live.dead.length,
    watermarks: snapshot.watermarks, nodeObservedAt: live.nodeObservedAt,
    completeUsageRatio: calls.length ? tokens.completeUsageCalls / calls.length : null,
    priceCoverageRatio: calls.length ? priced.length / calls.length : null,
    inFlightCalls: calls.filter(call => !call.finish).length,
    lateBackfill: calls.some(call => call.finish !== undefined && call.finish.observedAt > call.finish.endedAt),
    complete: snapshot.complete }
}

/** Estimated cache state for one session and cache epoch. */
export interface LedgerCacheRemaining {
  sessionId: string
  state: 'estimated' | 'auto' | 'unknown' | 'disabled'
  remainingSeconds?: number
  evidenceAt?: number
  cacheEpoch?: string
}
/** Read the latest cache evidence; breaks invalidate previous countdowns.
 * @param snapshot - public ledger snapshot.
 * @param asOf - observation wall clock.
 * @param options - optional root-session/descendant selection.
 * @returns one state per visible session; automatic retention never counts down.
 */
export function cacheRemaining(snapshot: LedgerSnapshot, asOf: number, options: LedgerQueryOptions): LedgerCacheRemaining[] {
  const selected = selectLedger(snapshot, options).snapshot
  const sessions = new Set(selected.rows.map(row => row.kind === 'event' ? row.event.sessionId : row.start.sessionId))
  if (options.sessionId) sessions.add(options.sessionId)
  return [...sessions].sort().map((sessionId) => {
    const auxiliary = new Set(selected.rows.flatMap(row => row.kind === 'call'
      && row.start.purpose !== 'conversation' && row.start.purpose !== 'keepalive' ? [row.start.callId] : []))
    const observations = selected.rows.flatMap<{
      evidence: LedgerCacheEvidence
      observedAt: number
      eventId: string
      kind: 'cache/evidence' | 'cache/break'
    }>((row) => {
      if (row.kind === 'call' && row.start.sessionId === sessionId && !auxiliary.has(row.start.callId)) {
        return [{ evidence: row.finish?.cache ?? row.start.cache, observedAt: row.finish?.observedAt ?? row.start.startedAt,
          eventId: row.start.callId, kind: 'cache/evidence' }]
      }
      if (row.kind === 'event' && row.event.sessionId === sessionId
        && (row.event.kind === 'cache/evidence' || row.event.kind === 'cache/break')
        && (row.event.callId === undefined || !auxiliary.has(row.event.callId))) return [row.event]
      return []
    }).filter(item => item.observedAt <= asOf)
      .sort((a, b) => b.observedAt - a.observedAt || compare(b.eventId, a.eventId))
    const latest = observations[0]
    if (!snapshot.complete || !latest) return { sessionId, state: 'unknown' }
    const evidence = latest.evidence
    if (evidence.cacheMode === 'automatic') return { sessionId, state: 'auto', ...evidence.cacheEpoch === undefined ? {} : { cacheEpoch: evidence.cacheEpoch } }
    if (evidence.cacheMode === 'disabled') return { sessionId, state: 'disabled', ...evidence.cacheEpoch === undefined ? {} : { cacheEpoch: evidence.cacheEpoch } }
    if (latest.kind === 'cache/break' || evidence.cacheMode !== 'explicit' || evidence.lastCacheEvidenceAt === undefined
      || evidence.lastCacheEvidenceAt > asOf || evidence.ttlSeconds === undefined) return { sessionId, state: 'unknown', ...evidence.cacheEpoch === undefined ? {} : { cacheEpoch: evidence.cacheEpoch } }
    return { sessionId, state: 'estimated', remainingSeconds: Math.max(0, Math.floor((evidence.lastCacheEvidenceAt + evidence.ttlSeconds * 1000 - asOf) / 1000)),
      evidenceAt: evidence.lastCacheEvidenceAt, ...evidence.cacheEpoch === undefined ? {} : { cacheEpoch: evidence.cacheEpoch } }
  })
}
