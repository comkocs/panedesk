/** Bounded ledger checkpoint projection settings. */
export interface CompactionLedgerOptions {
  /** Maximum recent events after the visible in-flight descendant list. */
  recentEventLimit: number
  /** Token ceiling for escaped runtime ledger data, charged before final checkpoint admission. */
  maxTokens: number
  /** Bound retries when the session revision or ledger watermark changes. */
  snapshotRetries: number
}
