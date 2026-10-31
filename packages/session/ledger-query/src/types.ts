/** Read-only ledger filtering, export, and daily overview vocabulary. */
export type * from './stats-types.ts'
import type { LedgerQuery, LedgerSnapshot, LedgerTokenColumns, LedgerWatermark, LedgerRow } from '@panedesk/dsh-session-ledger'
import type { MessageQuery, MessageStatus, MessageStateData, MessageState, MessageCursor, NodeId } from '@panedesk/dsh-message-delivery'

/** Structural view of the optional message-ledger projection, matching its owning provider. */
export interface LedgerMessageProjection extends MessageStatus {
  readonly nodeId: NodeId
  readonly data: MessageStateData
  readonly createdAt: number
  readonly stateTimes: Readonly<Partial<Record<MessageState, number>>>
}
/** One message page retains scan integrity independently of cursor exhaustion. */
export interface LedgerMessagesPage {
  readonly items: readonly LedgerMessageProjection[]
  readonly complete: boolean
  readonly asOf: number
  readonly nextCursor?: MessageCursor
}
/** Independent call and message journals joined by real Session identities. */
export interface LedgerSessionsPage {
  readonly asOf: number
  readonly complete: boolean
  readonly sessions: readonly {
    readonly sessionId: NonNullable<MessageQuery['sessionId']>
    readonly calls: readonly LedgerRow[]
    readonly messages: readonly LedgerMessageProjection[]
  }[]
  readonly unassignedMessages: readonly LedgerMessageProjection[]
}
/** Optional public reader additions; absence is reported, never replaced with delivery.list. */
export interface MessageLedgerReader {
  /** Read current message states with creation-time filters.
   * @param query - Selection and exclusive pagination.
   * @returns Status page and full-scan integrity.
   */
  queryMessages(query: MessageQuery): Promise<LedgerMessagesPage>
  /** Read both journal namespaces grouped by Session.
   * @param query - Shared Session and half-open time selection.
   * @returns Non-atomic joined view and combined integrity.
   */
  querySessions(query: Pick<LedgerQuery, 'sessionId' | 'from' | 'to'>): Promise<LedgerSessionsPage>
}

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
  value?: number | undefined
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
