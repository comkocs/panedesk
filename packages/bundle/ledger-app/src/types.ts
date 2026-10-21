/** Offline ledger application selection; profile wiring belongs to the launcher composition. */
export interface LedgerAppOptions {
  /** Query exits after its operation; watch remains active until disposed. */
  mode: 'query' | 'watch'
}
