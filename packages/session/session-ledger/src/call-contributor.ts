/** Runtime-only cache contributions to the ledger-owned physical call. */
import type { Agent } from '@panedesk/dsh-agent'
import type { GenerateOptions, LlmAdapter, StreamChunk, TokenUsage } from '@panedesk/dsh-llm'
import type { LedgerAuxiliaryFact, LedgerCacheEvidence, LedgerCallStart } from './types.ts'

/** Durable capabilities available only after the call start has committed. */
export interface CallContributionScope {
  readonly start: LedgerCallStart
  readonly signal: AbortSignal
  /** Append auxiliary evidence under this call identity.
   * @param value - Cache observation or alert.
   * @returns Durable acknowledgement; failure blocks later calls.
   */
  fact(value: LedgerAuxiliaryFact): Promise<void>
  /** Append and close a restricted request artifact under this call identity.
   * @param kind - Sidecar category.
   * @param content - Exact serialized JSON bytes.
   * @param index - Contiguous fragment sequence.
   * @returns Durable closure acknowledgement.
   */
  artifact(kind: 'keepalive-request', content: string, index: number): Promise<void>
}

/** One call's captured contribution; unregistering does not abandon in-flight settlement. */
export interface CallContribution {
  readonly evidence: LedgerCacheEvidence
  readonly modelFamily: string
  readonly signal: AbortSignal
  /** Publish cache state and append breakpoints after durable start.
   * @param scope - Capabilities bound to the committed call.
   * @returns Completion before admission.
   */
  started(scope: CallContributionScope): Promise<void>
  /** Acquire admission before adapter dispatch.
   * @param signal - Combined caller, ledger and contributor cancellation.
   * @returns Release function retained by the ledger until stream closure.
   */
  acquire(signal: AbortSignal): Promise<() => void>
  /** Update cache evidence from the original terminal chunk before pricing.
   * @param observation - Adapter evidence and authoritative observed usage.
   */
  terminal(observation: {
    finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    terminalEvidence: NonNullable<typeof LlmAdapter.ledgerEvidence> extends WeakMap<StreamChunk, infer T> ? T | undefined : never
    usage: TokenUsage | undefined
  }): void | Promise<void>
  /** Record an interjection breakpoint before terminal persistence.
   * @returns Durable breakpoint acknowledgement.
   */
  interjected(): Promise<void>
  /** Persist final cache evidence after durable call settlement.
   * @returns Durable cache observation acknowledgement.
   */
  settled(): Promise<void>
  /** Release this call's cache activity even when start or settlement failed.
   * @param failure - Accounting failure blocking subsequent cache calls, when present.
   * @returns Completion of contribution cleanup.
   */
  dispose(failure?: unknown): void | Promise<void>
}

/** Optional cache owner registered on one ledger instance, independent of plugin load order. */
export interface CallContributor {
  /** Freeze request cache evidence before call/start; reject before dispatch on failure.
   * @param call - Request, session identity and auxiliary-call isolation.
   * @returns Per-call contribution retained until stream settlement and cleanup.
   */
  prepare(call: {
    request: GenerateOptions
    id: string
    agent: Agent | undefined
    auxiliary: boolean
  }): Promise<CallContribution>
}
