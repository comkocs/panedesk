/** Public projection export/import; this format is not the ledger provider's journal. */
import { open, writeFile } from 'node:fs/promises'
import { projectWaits, withoutWaitProjection } from '@panedesk/dsh-session-ledger'
import type { LedgerCall, LedgerRow, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type { LedgerExportFormat } from './types.ts'
import { sortRows, sumUsd, summarizeToday, tokenColumns } from './query.ts'

/** Unequal projections sharing an identity are retained outside the merged rows. */
export interface LedgerMergeConflict { key: string; variants: readonly LedgerRow[] }
/** Merge result retains session association and all conflicting variants. */
export interface LedgerMergeResult {
  snapshot: LedgerSnapshot
  conflicts: readonly LedgerMergeConflict[]
  sessions: Readonly<Record<string, readonly LedgerRow[]>>
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
function rowKey(row: LedgerRow): string {
  return row.kind === 'call' ? `call:${row.start.callId}` : row.kind === 'run' ? `run:${row.start.runId}` : `event:${row.event.eventId}`
}
/** Deduplicate identities without silently selecting between unequal facts.
 * @param snapshots - node snapshots or previously exported views.
 * @returns stable unique rows, session associations, and excluded conflict sets.
 */
export function mergeLedger(snapshots: readonly LedgerSnapshot[]): LedgerMergeResult {
  const slots = new Map<string, LedgerRow>()
  const duplicates = new Map<string, Map<string, LedgerRow>>()
  const watermarks = new Map<string, LedgerSnapshot['watermarks'][string]>()
  const conflictingNodes = new Set<string>()
  for (const snapshot of snapshots) {
    for (const [node, watermark] of Object.entries(snapshot.watermarks)) {
      if (watermarks.has(node) && watermarks.get(node) !== watermark) { watermarks.delete(node); conflictingNodes.add(node) }
      else if (!conflictingNodes.has(node)) watermarks.set(node, watermark)
    }
    for (const row of snapshot.rows) {
      const key = rowKey(row)
      const fact = withoutWaitProjection(row)
      const prior = slots.get(key)
      if (!prior) { slots.set(key, fact); continue }
      let variants = duplicates.get(key)
      if (!variants) { variants = new Map([[canonical(prior), prior]]); duplicates.set(key, variants) }
      variants.set(canonical(fact), fact)
    }
  }
  const rows: LedgerRow[] = [], conflicts: LedgerMergeConflict[] = []
  for (const [key, row] of [...slots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const variants = duplicates.get(key)
    if (!variants) { rows.push(row); continue }
    const values = [...variants.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value)
    const first = values[0]
    if (values.length === 1 && first) rows.push(first)
    else conflicts.push({ key, variants: values })
  }
  const sorted = sortRows(projectWaits(rows))
  const sessions = new Map<string, LedgerRow[]>()
  for (const row of sorted) {
    const id = row.kind === 'event' ? row.event.sessionId : row.start.sessionId
    const items = sessions.get(id) ?? []
    items.push(row); sessions.set(id, items)
  }
  return { snapshot: { asOf: snapshots.length ? Math.min(...snapshots.map(snapshot => snapshot.asOf)) : 0,
    complete: snapshots.every(snapshot => snapshot.complete) && conflicts.length === 0 && conflictingNodes.size === 0,
    watermarks: Object.fromEntries(watermarks), rows: sorted }, conflicts, sessions: Object.fromEntries(sessions) }
}
function csvCell(value: unknown): string {
  let text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  if (/^(?:\s|[\u0000-\u001f])*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
/** Serialize public rows with missing flags; CSV includes disjoint token columns.
 * @param snapshot - source watermarks and projections.
 * @param format - lossless JSONL or formula-safe CSV.
 * @returns complete UTF-8 text.
 */
export function serializeLedger(snapshot: LedgerSnapshot, format: LedgerExportFormat): string {
  const rows = sortRows(snapshot.rows)
  if (format === 'jsonl') return [JSON.stringify({ kind: 'snapshot', asOf: snapshot.asOf, complete: snapshot.complete, watermarks: snapshot.watermarks }), ...rows.map(row => JSON.stringify(row))].join('\n') + '\n'
  const fields = ['kind', 'sessionId', 'nodeId', 'callId', 'startedAt', 'seat', 'window', 'taskId', 'model', 'purpose', 'inputTokens', 'cacheReadTokens', 'cacheWriteShortTokens', 'cacheWriteLongTokens', 'outputTokens', 'cacheWriteTokens', 'cacheWriteTiering', 'costUsd', 'usageState', 'pricingState', 'raw']
  const records = rows.map((row) => {
    if (row.kind !== 'call') return { kind: row.kind, sessionId: row.kind === 'run' ? row.start.sessionId : row.event.sessionId, raw: row }
    return { kind: row.kind, ...row.start, ...tokenColumns(row), model: row.finish?.effectiveModel ?? row.start.requestedModel,
      costUsd: row.finish?.costUsd, usageState: row.finish?.usageState ?? 'missing', pricingState: row.finish?.pricingState ?? 'missing-usage', raw: row }
  })
  return [fields.map(csvCell).join(','), ...records.map(record => fields.map(field => csvCell(Reflect.get(record, field))).join(','))].join('\r\n') + '\r\n'
}
/** Write only a caller-selected new export file; existing files are not overwritten.
 * @param snapshot - selected public projections.
 * @param format - output format.
 * @param outputPath - explicit destination supplied by the caller.
 * @returns acknowledgement after the file write completes.
 */
export async function writeExport(snapshot: LedgerSnapshot, format: LedgerExportFormat, outputPath: string): Promise<void> {
  await writeFile(outputPath, serializeLedger(snapshot, format), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function strings(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every(key => typeof value[key] === 'string') }
function cache(value: unknown): boolean {
  return object(value) && ['disabled', 'explicit', 'automatic', 'unknown'].includes(String(value.cacheMode))
    && Array.isArray(value.breakReasons) && value.breakReasons.every(item => typeof item === 'string')
    && (value.ttlSeconds === undefined || number(value.ttlSeconds))
    && (value.lastCacheEvidenceAt === undefined || number(value.lastCacheEvidenceAt))
}
function identity(value: unknown): boolean {
  return object(value) && strings(value, ['nodeId']) && number(value.pid) && Number.isSafeInteger(value.pid) && value.pid > 0
    && number(value.registeredAt) && ['verified', 'unverified'].includes(String(value.verification))
    && (value.startIdentity === undefined || typeof value.startIdentity === 'string') && (value.bootIdentity === undefined || typeof value.bootIdentity === 'string')
}
function validRow(value: unknown): value is LedgerRow {
  if (!object(value)) return false
  if (value.kind === 'event') {
    const e = value.event
    if (!object(e) || e.schemaVersion !== 1 || !strings(e, ['eventId', 'nodeId', 'runId', 'sessionId']) || !number(e.observedAt)) return false
    switch (e.kind) {
      case 'cache/evidence': case 'cache/break': return cache(e.evidence)
      case 'process/observed': return identity(e.identity) && ['confirmed', 'unknown', 'dead'].includes(String(e.liveness))
      case 'alert': return object(e.alert) && strings(e.alert, ['code', 'message']) && typeof e.alert.redacted === 'boolean'
      case 'call/start': return object(e.data) && validRow({ kind: 'call', start: e.data })
      case 'call/end': return validCallFinish(e.data)
      case 'run/start': return object(e.data) && validRow({ kind: 'run', start: e.data, liveness: 'unknown' })
      case 'run/end': return validRunFinish(e.data)
      case 'wait/start': case 'wait/end': return object(e.interval) && number(e.interval.startedAt) && typeof e.interval.kind === 'string'
      case 'retry': return strings(e, ['logicalRequestId']) && number(e.attemptIndex) && ['scheduled', 'started', 'exhausted'].includes(String(e.phase))
      case 'compaction': return number(e.committedSeq) && number(e.committedAt)
      case 'delivery': return Array.isArray(e.paths) && e.paths.every(path => typeof path === 'string') && ['not-requested', 'present', 'missing', 'uncheckable'].includes(String(e.state))
      case 'policy/denied': return strings(e, ['requested', 'definition', 'reason']) && ['model', 'effort', 'tool'].includes(String(e.operation))
      default: return false
    }
  }
  if (value.kind !== 'call' && value.kind !== 'run') return false
  const start = value.start
  if (!object(start) || !strings(start, ['runId', 'sessionId', 'rootSessionId', 'nodeId', 'seat', 'window', 'accountLabel']) || !number(start.startedAt)) return false
  if (!['startup', 'environment', 'settings', 'inherited', 'free'].includes(String(start.identitySource))) return false
  for (const key of ['parentSessionId', 'remoteSessionId', 'taskId']) if (start[key] !== undefined && typeof start[key] !== 'string') return false
  if (value.kind === 'run') return ['confirmed', 'unknown', 'dead'].includes(String(value.liveness)) && ['pending', 'started'].includes(String(start.launchState))
    && Array.isArray(start.deliveryPaths) && start.deliveryPaths.every(path => typeof path === 'string')
    && (start.processIdentity === undefined || identity(start.processIdentity))
    && (value.finish === undefined || validRunFinish(value.finish) && value.finish.runId === start.runId)
  if (!strings(start, ['callId', 'logicalRequestId', 'provider', 'modelFamily', 'requestedModel', 'purpose', 'priceVersion', 'priceKey']) || !cache(start.cache)
    || !number(start.attemptIndex) || !['physical', 'adapter'].includes(String(start.attemptVisibility)) || start.referencePrice !== true || !object(start.cacheWriteTiering)) return false
  if (start.requestHeaderSeq !== undefined
    && (!number(start.requestHeaderSeq) || !Number.isSafeInteger(start.requestHeaderSeq))) return false
  const tier = start.cacheWriteTiering
  if (!(tier.kind === 'untiered' || tier.kind === 'unknown' || tier.kind === 'tiered' && strings(tier, ['short', 'long']))) return false
  return value.finish === undefined || validCallFinish(value.finish) && value.finish.callId === start.callId
}
function validRunFinish(value: unknown): value is Record<string, unknown> {
  return object(value) && strings(value, ['runId']) && number(value.observedAt) && typeof value.recovered === 'boolean'
    && ['completed', 'timeout', 'killed', 'error', 'cancelled'].includes(String(value.endReason))
    && ['not-requested', 'present', 'missing', 'uncheckable'].includes(String(value.deliveryState))
    && (value.endedAt === undefined || number(value.endedAt))
}
function validCallFinish(value: unknown): value is Record<string, unknown> {
  if (!object(value) || !strings(value, ['callId', 'effectiveModel']) || !['complete', 'partial', 'missing'].includes(String(value.usageState))
    || !['priced', 'missing-price', 'missing-usage', 'partial-usage'].includes(String(value.pricingState))
    || !['completed', 'timeout', 'killed', 'error', 'cancelled'].includes(String(value.endReason))
    || !['same', 'different', 'missing', 'unobservable'].includes(String(value.responseModelReported))
    || !['endedAt', 'observedAt', 'wallMs', 'modelInFlightMs', 'queueMs', 'backoffMs', 'compactionCount'].every(key => number(value[key]))
    || !Array.isArray(value.waits) || !Array.isArray(value.compactionTimes) || !value.compactionTimes.every(number) || typeof value.recovered !== 'boolean') return false
  if (value.costUsd !== undefined && (typeof value.costUsd !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.costUsd))) return false
  if (value.pricingState === 'priced' && value.costUsd === undefined) return false
  if (value.usage !== undefined) {
    if (!object(value.usage) || !number(value.usage.inputTokens) || !number(value.usage.outputTokens)) return false
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'cacheWriteLongTokens', 'totalTokens', 'reasoningTokens']) if (value.usage[key] !== undefined && !number(value.usage[key])) return false
    if (typeof value.usage.cacheWriteLongTokens === 'number' && (typeof value.usage.cacheWriteTokens !== 'number' || value.usage.cacheWriteLongTokens > value.usage.cacheWriteTokens)) return false
  }
  return value.usageState !== 'complete' || value.usage !== undefined
}
/** Parse only the public export format and reject malformed or partial input.
 * @param text - exported UTF-8 JSONL, never provider-private journal bytes.
 * @returns validated snapshot with its original read watermarks.
 */
export function parseLedgerExport(text: string): LedgerSnapshot {
  if (!text.endsWith('\n')) throw new Error('Incomplete ledger export')
  const lines = text.trimEnd().split('\n')
  const header: unknown = JSON.parse(lines.shift() ?? '')
  if (!object(header) || header.kind !== 'snapshot' || !number(header.asOf) || typeof header.complete !== 'boolean'
    || !object(header.watermarks) || !Object.values(header.watermarks).every(value => typeof value === 'string')) throw new Error('Invalid ledger export header')
  const rows = lines.map((line) => {
    const row: unknown = JSON.parse(line)
    if (!validRow(row)) throw new Error('Invalid ledger export row')
    return row
  })
  return { asOf: header.asOf, complete: header.complete, watermarks: header.watermarks as LedgerSnapshot['watermarks'], rows }
}
/** Load a public export with a finite import size bound.
 * @param path - explicit caller-provided JSONL path.
 * @returns validated public snapshot.
 */
export async function readLedgerExport(path: string): Promise<LedgerSnapshot> {
  const file = await open(path, 'r')
  try {
    const limit = 64 * 1024 * 1024
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('Ledger export exceeds import limit or is not a regular file')
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of file.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
      total += chunk.length
      if (total > limit) throw new Error('Ledger export exceeds import limit')
      chunks.push(chunk)
    }
    return parseLedgerExport(Buffer.concat(chunks).toString('utf8'))
  } finally { await file.close() }
}
/** Independently re-add raw observed buckets and money, then compare the public summary.
 * @param snapshot - imported or service snapshot.
 * @param asOf - half-open query instant.
 * @param freshnessMs - freshness policy used for the accompanying live classification.
 * @returns independent call totals, summary, and explicit verification status.
 */
export function verifyLedger(snapshot: LedgerSnapshot, asOf: number, freshnessMs: number): {
  valid: boolean
  recomputed: { costUsd: string; tokens: number; cacheReadTokens: number; inputTokensIncludingCache: number; unknownCostCalls: number }
  summary: ReturnType<typeof summarizeToday>
  conflicts: ReturnType<typeof mergeLedger>['conflicts']
} {
  const merged = mergeLedger([snapshot])
  const summary = summarizeToday(merged.snapshot, asOf, freshnessMs)
  const date = new Date(asOf + 28800000)
  const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 28800000
  const calls: LedgerCall[] = []
  for (const row of merged.snapshot.rows) if (row.kind === 'call' && row.start.startedAt >= from && row.start.startedAt < asOf) calls.push(row)
  let tokens = 0, reads = 0, inputs = 0, unknownCostCalls = 0
  const costs: string[] = []
  for (const call of calls) {
    const usage = call.finish?.usage
    if (usage) {
      tokens += usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      if (call.start.purpose !== 'keepalive') { reads += usage.cacheReadTokens ?? 0; inputs += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) }
    }
    if (call.finish?.pricingState === 'priced' && call.finish.costUsd !== undefined) costs.push(call.finish.costUsd)
    else unknownCostCalls++
  }
  const recomputed = { costUsd: sumUsd(costs), tokens, cacheReadTokens: reads, inputTokensIncludingCache: inputs, unknownCostCalls }
  return { valid: merged.conflicts.length === 0 && snapshot.complete && recomputed.costUsd === summary.costUsd
    && tokens === summary.tokens.knownTokens && reads === summary.cacheHitRate.cacheReadTokens
    && inputs === summary.cacheHitRate.inputTokensIncludingCache
    && unknownCostCalls === summary.unknownCostCalls, recomputed, summary, conflicts: merged.conflicts }
}
