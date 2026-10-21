/** Service definition for durable call and lifecycle accounting; providers own storage and pricing. */
import { Context, Service } from '@panedesk/cordis'
import type {
  LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult,
  LedgerArtifactFinishResult, LedgerArtifactReference, LedgerCallFinish, LedgerCallStart, LedgerEvent,
  LedgerOptions, LedgerWaitCategory,
  LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery,
  LedgerRunFinish, LedgerRunStart, LedgerSnapshot,
} from './types.ts'
export type * from './types.ts'

/** Trusted configuration accepted by concrete ledger providers. */
export type Config = LedgerOptions

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
  /** Register trusted wait metadata; runtime registrations take precedence over configured defaults.
   * Equal registrations may coexist; conflicting live categories are rejected rather than last-writer-wins.
   * @param toolName - exact runtime-registered tool name, never model-supplied category metadata.
   * @param category - trusted wait classification.
   * @returns idempotent disposer releasing only this registration; the last release restores configuration or unclassified.
   */
  abstract registerWaitTool(toolName: string, category: LedgerWaitCategory): () => void
  /** Append a restricted JSON sidecar fragment uniquely keyed by callId, kind, and seq.
   * A new sequence must be contiguous; gaps, malformed JSON, and new fragments after closure reject.
   * Exact replays remain valid after closure. Success is returned only after file and required directory fsync.
   * @param input - immutable identity and exact serialized content bytes.
   * @returns durable reference, existing reference for equal bytes, or a conflict without overwriting.
   */
  abstract appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult>
  /** Close a sidecar durably; a mismatching reference or a non-final sequence rejects without mutation.
   * Repeating the same closure is idempotent; acknowledgement follows fsync of the closure marker.
   * @param reference - last durable fragment returned by appendArtifact; an empty stream has no closure reference.
   * @returns durable closure acknowledgement suitable for call/end linkage.
   */
  abstract finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult>
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
