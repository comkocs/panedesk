/** Read-only service definition for ledger selection, daily summaries, and safe exports. */
import { Context, Service } from '@panedesk/cordis'
import type { LedgerExportOptions, LedgerExportResult, LedgerQueryOptions, LedgerQueryResult, LedgerTodaySummary } from './types.ts'
export type * from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    ledgerQuery: LedgerQueryService
  }
}

/** Query providers read ledger snapshots without launching an Agent or model provider. */
export abstract class LedgerQueryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ledgerQuery')
  }

  /** Select and group unique call projections.
   * @param options - half-open time, attribution, and grouping selection.
   * @returns source snapshot and coverage-aware grouped totals.
   */
  abstract query(options: LedgerQueryOptions): Promise<LedgerQueryResult>
  /** Compute today's overview at the runtime clock or an explicit observation instant.
   * @param asOf - optional UTC millisecond observation time; omission reads the system clock.
   * @returns Beijing-day totals and node observation coverage.
   */
  abstract today(asOf?: number): Promise<LedgerTodaySummary>
  /** Export selected rows in stable time, node, and call order.
   * @param options - selection, format, and caller-authorized destination.
   * @returns output acknowledgement and source snapshot watermarks.
   */
  abstract export(options: LedgerExportOptions): Promise<LedgerExportResult>
}

export default LedgerQueryService
