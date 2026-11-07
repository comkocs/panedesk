/** Administration adapters preserve the existing approval path and its journal transaction. */
import type * as Seat from '@panedesk/dsh-seat'
import type { HostAdminAuthority, HostAdminExecutor, HostAdminRequest, HostAdminSourceOperator } from './index.ts'

/** An authenticated local entry supplies a scoped issuer, never a role inferred from a name. */
export interface HostAdminAuthorizationPolicy {
  /** Recheck transport method rights, current local policy and target binding.
   * Node delegation never acquires local-operator approval permission by sharing a principal ID.
   * @param request - Validated fixed-method request without caller-supplied role.
   * @param authority - Transport-derived identity and permission ceiling.
   * @returns Exact-operation issuer or a safe refusal; no audit reference alone grants authority.
   */
  authorize(request: HostAdminRequest, authority: HostAdminAuthority): Promise<Seat.SeatAuthorizationIssuer | Seat.SeatRejected>
}
/** The running engine remains the sole admission owner; queries never start another instance. */
export interface HostAdminExecutionDependencies {
  /** Optional source owner; omitted capabilities return method-unavailable. */
  readonly sourceOperator?: HostAdminSourceOperator
  readonly nodeId: Seat.SeatNodeId
  readonly policy?: HostAdminAuthorizationPolicy
  readonly authorization?: Seat.SeatAuthorizationTransactions
  readonly engine: Seat.SeatEngineService
  readonly queries?: Seat.SeatAuthorizationQueries
  /** Optional local-to-peer rebuild; omitted peer retains the configured transport selection. Absence starts nothing. */
  readonly rebuildTransport?: (peerNodeId?: Seat.SeatNodeId) => Promise<{ status: 'rebuilt' | 'unavailable' }>
}
/** Implementations are explicitly installed as hostAdminExecutor by the local host. */
export interface HostAdminExecutionAdapter {
  /** Preserve pending-version checks and commit authorization plus approval in one engine decision.
   * Do not prewrite an audit record then call unaudited approve(): those are two transactions.
   * Use the original approval admission path with its transactional capability; confirmation does
   * not bypass time, capacity, budget, identity or scope gates. No adapter may route another hop.
   * Missing adapter or journal capability refuses writes with admin-method-unavailable;
   * existing node.status/engine.pending read-only fallback remains unchanged.
   * @param dependencies - Running local engine, redacted queries and trusted audit capabilities.
   * @returns Existing executor interface; importing this declaration installs no service.
   */
  create(dependencies: HostAdminExecutionDependencies): HostAdminExecutor
}
