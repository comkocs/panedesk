/** Optional source operations retain provider-owned audit and delivery semantics. */
import type { SeatAuthorizationGrant } from '@panedesk/dsh-seat'

/** The original process-local cancellation grant, never reconstructed from wire facts. */
export type HostAdminGrant = SeatAuthorizationGrant
/** Exact provider key and operator reason bound to one operation. */
export interface SourceOperatorWriteParams { operationId: string; key: string; reason: string }
/** Provider evidence for work requiring an operator decision. */
export interface SourceOperatorItem {
  key: string
  state: 'awaiting-manual' | 'parked-none'
  eventId: string
  target: string
  /** ISO timestamp supplied by the source owner. */
  since: string
  ticket?: string
  detail?: string
  /** Optional read-only retry evidence; missing timestamps and counters remain unknown. */
  observation?: {
    source: string
    parkingCode: string
    firstAttemptAt: string | null
    lastAttemptAt: string | null
    count: number | null
    attemptsAtLeast: boolean
    latestReason: string | null
  }
}
/** Provider-owned outcome; an optional generation identifies a directed resend. */
export interface SourceOperatorResult {
  status: 'ok' | 'rejected'
  code?: string
  reason?: string
  generation?: number
  /** Set only when the provider refused before producing an effect, so the same operation may be retried. */
  effect?: 'none'
}
/** Optional local source owner; absence never starts another engine or delivery path. */
export interface HostAdminSourceOperator {
  /** List source work without changing its state.
   * @param params - Optional page limit from 1 through 200.
   * @returns At most 200 provider items, preserving their full keys.
   */
  list(params: { limit?: number }): Promise<{ items: SourceOperatorItem[] }>
  /** Delegate abandonment to the source owner after exact-operation authorization.
   * @param params - Operation identity, original key and bounded reason.
   * @param grant - Original local-operator grant, including audit attribution.
   * @returns Provider result after its audit and release decisions.
   */
  abandon(params: SourceOperatorWriteParams, grant: HostAdminGrant): Promise<SourceOperatorResult>
  /** Delegate directed resend when the source owner supplies this capability.
   * @param params - Operation identity, original key and bounded reason.
   * @param grant - Original local-operator grant, including audit attribution.
   * @returns Provider result after its admission and generation decisions.
   */
  resend?(params: SourceOperatorWriteParams, grant: HostAdminGrant): Promise<SourceOperatorResult>
}
