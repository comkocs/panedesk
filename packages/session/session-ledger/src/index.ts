/** Service definition for durable call and lifecycle accounting; providers own storage and pricing. */
import { Context, Service } from '@panedesk/cordis'
import type {
  LedgerAppendResult, LedgerCallFinish, LedgerCallStart, LedgerEvent,
  LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery,
  LedgerRunFinish, LedgerRunStart, LedgerSnapshot,
} from './types.ts'
export type * from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    sessionLedger: SessionLedger
  }
}

/** Durable ledger operations fail closed before model dispatch when the start cannot be committed. */
export abstract class SessionLedger extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionLedger')
  }

  /** Persist one call start before releasing network dispatch.
   * @param input - immutable request and attribution facts.
   * @returns committed or existing start, or an explicit conflicting-payload result.
   */
  abstract beginCall(input: LedgerCallStart): Promise<LedgerAppendResult>
  /** Commit at most one terminal fact per call; late evidence never overwrites it.
   * @param input - observed terminal facts.
   * @returns committed or already existing terminal fact, or a conflict.
   */
  abstract finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult>
  /** Persist launch intent before permitting child execution.
   * @param input - reserved identities and trusted dispatch options.
   * @returns durable launch intent or conflict.
   */
  abstract beginRun(input: LedgerRunStart): Promise<LedgerAppendResult>
  /** Compare-and-set the terminal run slot; later observations are separate events.
   * @param input - normal settlement or verified death observation.
   * @returns first committed terminal fact, including when another writer won.
   */
  abstract finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult>
  /** Append a uniquely identified fact; equal replays are idempotent and unequal replays conflict.
   * @param event - complete versioned event, containing only runtime-authoritative evidence.
   * @returns durable append outcome after synchronization.
   */
  abstract appendEvent(event: LedgerEvent): Promise<LedgerAppendResult>
  /** Select projections without counting lifecycle or retry observations as extra calls.
   * @param filter - half-open business-time and identity selection.
   * @returns snapshot and explicit completeness/watermark evidence.
   */
  abstract query(filter: LedgerQuery): Promise<LedgerSnapshot>
  /** Read a consistent checkpoint view; absent filter selects all locally visible facts.
   * @param filter - optional visibility and session restriction.
   * @returns revisioned, bounded-by-watermark snapshot.
   */
  abstract snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot>
  /** Price authoritative usage with decimal fixed-point arithmetic, without inventing missing values.
   * @param request - frozen price entry, timestamp, tier names, and observed usage.
   * @returns reference USD amount or an explicit coverage gap.
   */
  abstract priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult
}

export default SessionLedger
