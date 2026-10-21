/** Read-only ledger filtering, export, and daily overview vocabulary. */
import type { LedgerQuery, LedgerSnapshot, LedgerTokenColumns, LedgerWatermark } from '@panedesk/dsh-session-ledger'

/** Supported lossless-machine and spreadsheet export formats. */
export type LedgerExportFormat = 'jsonl' | 'csv'
/** Stable grouping dimensions; account labels contain no credentials. */
export type LedgerGroupBy = 'seat' | 'window' | 'model' | 'modelFamily' | 'taskId' | 'sessionId' | 'nodeId' | 'purpose' | 'accountLabel'
/** Selection and optional grouping; repricing never changes stored historical amounts. */
export interface LedgerQueryOptions extends LedgerQuery {
  groupBy?: readonly LedgerGroupBy[]
  repriceVersion?: string
}
/** Export inputs; CSV implementations must neutralize formula-leading text. */
export interface LedgerExportOptions {
  query: LedgerQueryOptions
  format: LedgerExportFormat
  outputPath: string
}
/** Observed token buckets and coverage, not an assertion that missing calls were free. */
export interface LedgerUsageTotals extends LedgerTokenColumns {
  knownTokens: number
  completeUsageCalls: number
  totalCalls: number
}
/** Derived cache-read fraction; no denominator or incomplete evidence is explicit. */
export interface LedgerHitRate {
  value?: number
  state: 'complete' | 'partial' | 'unavailable'
  cacheReadTokens: number
  inputTokensIncludingCache: number
}
/** Daily four-number overview uses Asia/Shanghai midnight and call start times. */
export interface LedgerTodaySummary {
  from: number
  asOf: number
  timezone: 'Asia/Shanghai'
  costUsd: string
  keepaliveCostUsd: string
  unknownCostCalls: number
  tokens: LedgerUsageTotals
  cacheHitRate: LedgerHitRate
  cacheHitRateIncludingKeepalive: LedgerHitRate
  liveSessions: number
  unknownLivenessSessions: number
  deadSessions: number
  watermarks: Readonly<Record<string, LedgerWatermark>>
  nodeObservedAt: Readonly<Record<string, number>>
  completeUsageRatio: number | null
  priceCoverageRatio: number | null
  inFlightCalls: number
  lateBackfill: boolean
  complete: boolean
}
/** Grouped sums retain explicit unknown-cost and partial-usage coverage. */
export interface LedgerQueryGroup {
  keys: Readonly<Partial<Record<LedgerGroupBy, string>>>
  costUsd: string
  unknownCostCalls: number
  usage: LedgerUsageTotals
}
/** Query results always retain the source snapshot watermarks. */
export interface LedgerQueryResult {
  snapshot: LedgerSnapshot
  groups: readonly LedgerQueryGroup[]
}
/** Export acknowledgement, distinct from the underlying query coverage. */
export interface LedgerExportResult {
  outputPath: string
  rows: number
  snapshot: LedgerSnapshot
}
