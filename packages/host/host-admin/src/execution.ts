/** Administration adapters preserve the existing approval path and its journal transaction. */
import type * as Seat from '@panedesk/dsh-seat'
import type { HostAdminExecutor, HostAdminSourceOperator } from './index.ts'
/** The running engine remains the sole admission owner; queries never start another instance. */
export interface HostAdminExecutionDependencies {
  /** Optional source owner; omitted capabilities return method-unavailable. */
  readonly sourceOperator?: HostAdminSourceOperator
  readonly nodeId: Seat.SeatNodeId
  readonly engine: Seat.SeatEngineService
  readonly tasks?: (request: Seat.SeatTaskQueryRequest) => Promise<Seat.EngineQueryResult | Seat.SeatRejected>
  readonly operation?: (request: Seat.SeatOperationQuery) => Promise<Seat.SeatEngineOperationResult>
  /** Optional local-to-peer rebuild; omitted peer retains the configured transport selection. Absence starts nothing. */
  readonly rebuildTransport?: (peerNodeId?: Seat.SeatNodeId) => Promise<{ status: 'rebuilt' | 'unavailable' }>
}
/** Implementations are explicitly installed as hostAdminExecutor by the local host. */
export interface HostAdminExecutionAdapter {
  /** Preserve the running engine's pending-version checks and business admission rules.
   * Missing providers return admin-method-unavailable without starting another engine.
   * @param dependencies - Running local engine, business queries and optional providers.
   * @returns Existing executor interface; importing this declaration installs no service.
   */
  create(dependencies: HostAdminExecutionDependencies): HostAdminExecutor
}
