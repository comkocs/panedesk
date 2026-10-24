/** Independent authenticated host administration definitions; no listener is installed. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'

/** Administration framing never reuses browser launch credentials or Core operation numbers. */
export const HOST_ADMIN_VERSION = 'host-admin/v1' as const
/** Fixed administrative methods cannot become a shell or arbitrary file API. */
export const HOST_ADMIN_METHODS = ['node.status', 'engine.pending', 'engine.approve', 'engine.operation', 'engine.query'] as const
/** Request/result pairs reuse provider definitions rather than forking their semantics. */
export interface HostAdminMethods {
  'node.status': { request: Record<string, never>; result: Seat.SeatNodeStatus }
  'engine.pending': { request: Seat.ListPendingSeatsRequest; result: Seat.ListPendingSeatsResult | Seat.SeatRejected }
  'engine.approve': { request: Seat.ApprovePendingSeatRequest; result: Seat.PendingSeatMutationResult }
  'engine.operation': { request: Seat.SeatOperationQuery; result: Seat.SeatOperationResult }
  'engine.query': { request: Seat.SeatTaskQueryRequest; result: Seat.EngineQueryResult | Seat.SeatRejected }
}
/** A process epoch rejects stale metadata and PID reuse; it is not a credential. */
export interface HostAdminEndpoint {
  nodeId: Seat.SeatNodeId
  pid: number
  processEpoch: Branded<'HostProcessEpoch'>
  version: typeof HOST_ADMIN_VERSION
  credentialRef: Branded<'HostAdminCredentialRef'>
}
/** Wire payload cannot self-assign an operator role or a session binding. */
export type HostAdminRequest = { [K in keyof HostAdminMethods]: {
  version: typeof HOST_ADMIN_VERSION
  requestId: Branded<'HostAdminRequestId'>
  processEpoch: HostAdminEndpoint['processEpoch']
  nonce: Branded<'HostAdminNonce'>
  method: K
  params: HostAdminMethods[K]['request']
} }[keyof HostAdminMethods]
/** Safe failure codes do not expose authentication material. */
export const HOST_ADMIN_ERROR_CODES = ['admin-unavailable', 'admin-unauthorized', 'admin-stale-epoch', 'admin-method-unavailable', 'admin-outcome-unknown'] as const
/** Responses echo request IDs and preserve uncertain approval outcomes. */
export type HostAdminResponse = { [K in keyof HostAdminMethods]: {
  version: typeof HOST_ADMIN_VERSION
  requestId: Branded<'HostAdminRequestId'>
  method: K
} & ({ status: 'ok'; result: HostAdminMethods[K]['result'] } | {
  status: 'rejected' | 'unavailable' | 'uncertain'
  code: typeof HOST_ADMIN_ERROR_CODES[number]
  reason: string
  operationId?: Seat.SeatOperationId
}) }[keyof HostAdminMethods]
/** Authenticated transport derives authority independently of request parameters. */
export interface HostAdminAuthority {
  principalId: Seat.SeatPrincipalId
  authorizationRef: Seat.AuthorizationRef
  kind: 'local-operator' | 'node-delegation'
  methods: readonly (keyof HostAdminMethods)[]
}
/** Administration is optional and never starts a second engine to answer a query. */
export interface HostAdminService {
  /** Dispatch a fixed method after transport authentication and epoch validation.
   * @param request - Bounded validated request without caller-defined authority.
   * @param authority - Authenticated operator role narrowed to permitted methods.
   * @returns Provider evidence; approval records authorization before engine admission.
   */
  dispatch(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Optional authenticated provider; unavailable never falls back to starting a host. */
    hostAdmin: HostAdminService
  }
}
/** Loader identity keeps administration opt-in. */
export const name = 'host-admin'
/** Inert skeleton has no mandatory service dependencies. */
export const inject: string[] = []
/** No listener or credential options are accepted by the empty plugin. */
export interface Config { }
/** No network defaults are introduced by mounting this skeleton. */
export const Config: Schema<Config> = Schema.object({})
/** Mount an inert administration plugin.
 * @param _ctx - Owning plugin context.
 * @param _config - Empty skeleton configuration.
 */
export function apply(_ctx: Context, _config: Config): void {}
