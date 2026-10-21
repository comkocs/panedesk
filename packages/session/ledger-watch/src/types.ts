/** Process-observation settings for independent ledger reconciliation. */
export interface LedgerWatchOptions {
  /** Milliseconds between scans; the operational target is two seconds. */
  intervalMs: number
  /** Total lock/write budget per scan; stale observations must be reported. */
  settlementBudgetMs: number
  /** Reconcile already-dead process identities when the watcher starts. */
  scanOnStart: boolean
}
