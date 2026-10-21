/** Offline ledger application selection; profile wiring belongs to the launcher composition. */
export interface LedgerAppOptions {
  /** Query exits after its operation; watch remains active until disposed. */
  mode: 'query' | 'watch'
  /** Required local ledger node for watch mode; query mode does not use it. */
  nodeId?: string
  /** Optional watcher health destination; absence disables the health file. */
  healthPath?: string
}
