/** Read-only statistics retain unknown measurements as null and coverage alongside observed totals. */
import type { LedgerCall, LedgerTokenColumns } from '@panedesk/dsh-session-ledger'
import type { LedgerHitRate, LedgerUsageTotals } from './types.ts'

/** Fixed Beijing-day and rolling selections supported by the statistics panel. */
export type StatsRange = 'today' | '6h' | '24h' | '72h' | '168h' | 'all'
/** Exclusive detail position in ascending startedAt, nodeId, callId order; strings use code-unit order. */
export interface StatsDetailCursor {
  startedAt: number
  nodeId: LedgerCall['start']['nodeId']
  callId: LedgerCall['start']['callId']
  /** Reuse this exclusive observation instant on every subsequent page. */
  asOf: number
}
/** Explicit selection shared by all five tabs; absent filters select every authorized row. */
export interface StatsRequest {
  range: StatsRange
  bucket: 'hour' | 'day'
  groupBy: 'seat' | 'taskId' | 'model' | 'window' | 'role' | 'definition'
  seat?: string
  taskId?: string
  model?: string
  /** Omission returns all details; paging never limits aggregate calculations. */
  details?: { limit: number; after?: StatsDetailCursor }
}
/** Observed call-only sums, with unknown price and duration distinguished from zero. */
export interface StatsAggregate {
  key: string
  calls: number
  usage: LedgerUsageTotals
  costUsd: string | null
  unknownCostCalls: number
  modelInFlightMs: number | null
  outputTokensPerSecond: number | null
}
/** Unique unfinished child sessions, independent of the selected historical time range. */
export interface StatsRunningLanes {
  count: number | null
  unknownSessions: number
  complete: boolean
  bySeat: readonly { seat: string; count: number }[]
}
/** One physical call; missing evidence is never converted to zero or a paid charge. */
export interface StatsCallDetail {
  callId: LedgerCall['start']['callId']
  sessionId: LedgerCall['start']['sessionId']
  parentSessionId: NonNullable<LedgerCall['start']['parentSessionId']> | null
  seat: string
  window: string
  taskId: string | null
  model: string
  responseModelReported: NonNullable<LedgerCall['finish']>['responseModelReported'] | null
  purpose: string
  tokens: LedgerTokenColumns
  usageState: string
  costUsd: string | null
  priceVersion: string | null
  startedAt: number
  endedAt: number | null
  wallMs: number | null
  modelInFlightMs: number | null
  waits: NonNullable<LedgerCall['waitSummary']>['categories'] | null
  peakContextTokens: number | null
  compactionCount: number | null
  compactionTimes: readonly number[] | null
  endReason: string | null
  prefixFingerprint: string | null
  outputTokensPerSecond: number | null
}
/** Session-level window row; project cards use seat because the ledger has no workspace directory. */
export interface StatsWindow extends StatsAggregate {
  sessionId: LedgerCall['start']['sessionId']
  seat: string
  window: string
  taskIds: readonly string[]
  parentSessionId: NonNullable<LedgerCall['start']['parentSessionId']> | null
  running: boolean | null
}
/** A Beijing-aligned time bucket for one model. */
export interface StatsBucket extends StatsAggregate { startedAt: number; model: string }
/** All five tabs derive from one authorized snapshot and one observation instant. */
export interface StatsView {
  asOf: number
  from: number | null
  complete: boolean
  queryMs: number
  summary: StatsAggregate
  cacheHitRate: LedgerHitRate
  keepalive: StatsAggregate
  runningLanes: StatsRunningLanes
  runningWindows: number | null
  alerts: number | null
  projects: readonly StatsAggregate[]
  windows: readonly StatsWindow[]
  groups: readonly StatsAggregate[]
  models: readonly StatsAggregate[]
  buckets: readonly StatsBucket[]
  details: readonly StatsCallDetail[]
  nextDetailCursor: StatsDetailCursor | null
}
