import type { LedgerRunStart, LedgerRunFinish } from '@panedesk/dsh-session-ledger'

/** Confirmed durable owner death, published before repairing its unfinished calls. */
export interface LedgerOwnerSettled {
  readonly start: LedgerRunStart
  readonly finish: LedgerRunFinish
  readonly deathObservedAt: number
  readonly persistedAt: number
  readonly latencyMs: number
}

declare module '@panedesk/cordis' {
  interface Events {
    /**
     * A killed run has a durable terminal acknowledgement; consumers must fence by run identity.
     * @param payload - exact owner and acknowledged terminal evidence; repeat delivery is possible.
     * @mode emit
     */
    'ledger-watch/owner-settled'(payload: LedgerOwnerSettled): void
  }
}

/** Process-observation settings for independent ledger reconciliation. */
export interface LedgerWatchOptions {
  /** Milliseconds between scans; the operational target is two seconds. */
  intervalMs: number
  /** Total lock/write budget per scan; stale observations must be reported. */
  settlementBudgetMs: number
  /** Reconcile already-dead process identities when the watcher starts. */
  scanOnStart: boolean
  /** Explicit local ledger node; omission disables reconciliation rather than guessing ownership. */
  nodeId?: string
  /** Continuous polling is opt-in; omission performs only the configured startup scan. */
  continuous?: boolean
  /** Optional owner-only health file, refreshed after acknowledged successful rounds. */
  healthPath?: string
}
