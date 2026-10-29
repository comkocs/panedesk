/** Optional host administration definitions and runtime; listeners require explicit configuration. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'
import { mountAdmin } from './runtime.ts'
import type { PrivateFiles } from './private-files.ts'
import type { HostAdminSourceOperator, SourceOperatorItem, SourceOperatorWriteParams, SourceOperatorResult } from './source-operator.ts'

export type * from './source-operator.ts'

export { PosixPrivateFiles } from './private-files.ts'
export type { PrivateFiles } from './private-files.ts'
export { OperationStore } from './operation-store.ts'
export { drainRuntime, onRuntimeTermination } from './runtime-cleanup.ts'
export { listenLoopback, callLoopback, listenAuthenticatedLoopback } from './loopback.ts'
export type { RpcLimits, RpcAuthentication, LoopbackListener } from './loopback.ts'
export { canonical, digest, object, identifier, parseJson } from './json.ts'
export { callAdmin } from './client.ts'
export type * from './sdk.ts'
export { callHostSdk, callHostAdmin } from './sdk-client.ts'
export type { RunningHostOptions } from './sdk-client.ts'

/** Administration framing never reuses browser launch credentials or Core operation numbers. */
export const HOST_ADMIN_VERSION = 'host-admin/v1' as const
/** Fixed administrative methods cannot become a shell or arbitrary file API. */
export const HOST_ADMIN_METHODS = ['node.status', 'engine.pending', 'engine.approve', 'engine.operation', 'engine.query', 'engine.cancel', 'engine.callbackResolve', 'source.operations', 'source.abandon', 'source.resend'] as const
/** Request/result pairs reuse provider definitions rather than forking their semantics. */
export interface HostAdminMethods {
  'source.operations': { request: { limit?: number }; result: { items: SourceOperatorItem[] } }
  'source.abandon': { request: SourceOperatorWriteParams; result: SourceOperatorResult }
  'source.resend': { request: SourceOperatorWriteParams; result: SourceOperatorResult }
  'node.status': { request: Record<string, never>; result: Seat.SeatNodeStatus }
  'engine.pending': { request: Seat.ListPendingSeatsRequest; result: Seat.ListPendingSeatsResult | Seat.SeatRejected }
  'engine.approve': { request: Seat.ApprovePendingSeatRequest; result: Seat.PendingSeatMutationResult }
  'engine.cancel': { request: Seat.CancelPendingSeatRequest; result: Seat.PendingSeatMutationResult }
  'engine.callbackResolve': { request: HostAdminCallbackResolveRequest; result: HostAdminCallbackResolveResult }
  'engine.operation': { request: Seat.SeatOperationQuery; result: Seat.SeatEngineOperationResult }
  'engine.query': { request: HostAdminQueryRequest; result: HostAdminQueryResult | Seat.SeatRejected }
}
/** Operators resolve only an existing paused callback without replacing its identity. */
export type HostAdminCallbackResolveRequest = Seat.CallbackResolveRequest
/** Fixed resolution refusals leave the engine journal unchanged. */
export type HostAdminCallbackResolveResult = Seat.CallbackResolveResult
/** Optional running-engine capability; absence refuses the administrative write. */
export interface HostAdminCallbackResolver {
  /** Resolve using the engine's current local-operator grant.
   * @param request - Frozen callback action and expected attempt.
   * @param grant - Exact request authority issued by this engine.
   * @returns Current delivery state or a fixed refusal.
   */
  callbackResolve(request: HostAdminCallbackResolveRequest, grant: Seat.SeatAuthorizationGrant): Promise<HostAdminCallbackResolveResult>
}
/** Effect and authorization scans have independent exclusive cursors. */
export interface HostAdminQueryRequest extends Seat.SeatTaskQueryRequest {
  authorizationCursor?: Seat.EngineCursor
  kind?: Seat.SeatIssuedAuthorizationKind
}
/** Legacy executors may omit authorization pages; the installed engine adapter always supplies one. */
export interface HostAdminQueryResult extends Seat.EngineQueryResult {
  authorizations?: Seat.SeatIssuedAuthorizationQueryResult
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
/** Local executors own authorization facts and must durably record approval before admission. */
export interface HostAdminExecutor {
  /** Invoke only a locally authenticated capability, never another router.
   * @param request - Validated fixed-method request.
   * @param authority - Transport-derived narrowed authority.
   * @returns Provider evidence after required authorization persistence.
   */
  execute(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Optional executor supplied by the local orchestration provider; missing methods fail closed. */
    hostAdminExecutor: HostAdminExecutor
    /** Optional source owner, read at invocation time without a mandatory injection. */
    hostAdminSourceOperator: HostAdminSourceOperator
    /** Optional Windows ACL/path implementation; POSIX uses checked owner-only files when absent. */
    hostAdminFiles: (directory: string) => PrivateFiles
  }
}

/** Loader identity keeps administration opt-in. */
export const name = 'host-admin'
/** Inert skeleton has no mandatory service dependencies. */
export const inject: string[] = []
/** Omitted runtime leaves the plugin inert; explicit runtime enables only loopback administration. */
export interface Config {
  /** Explicit activation and limits for administration of the existing host. */
  runtime?: {
    /** Exclusive absolute directory for owner-only credentials and operation records. */
    directory: string
    /** Identity reported by the local node. */
    nodeId: string
    /** Authenticated principal assigned to local administration calls. */
    principalId: string
    /** Loopback listener port; zero allocates an ephemeral port. */
    port: number
    /** Maximum bytes in a complete request or response frame. */
    maxFrameBytes: number
    /** Maximum time in milliseconds to wait for a transport response. */
    requestTimeoutMs: number
    /** Maximum number of concurrent transport requests. */
    maxPending: number
    /** Maximum bytes in the durable operation store. */
    maxStoreBytes: number
    /** Maximum retained operation records before new operations reject. */
    maxOperations: number
  } | undefined
}
/** Deployment bounds have no implicit active-listener defaults. */
export const Config: Schema<Config> = Schema.object({ runtime: Schema.union([Schema.const(undefined), Schema.object({
  directory: Schema.string().required(), nodeId: Schema.string().required(), principalId: Schema.string().required(),
  port: Schema.number().min(0).max(65535).step(1).required(),
  maxFrameBytes: Schema.number().min(1).step(1).required(), requestTimeoutMs: Schema.number().min(1).max(2147483647).step(1).required(),
  maxPending: Schema.number().min(1).step(1).required(), maxStoreBytes: Schema.number().min(1).step(1).required(),
  maxOperations: Schema.number().min(1).step(1).required(),
})]) })
/** Mount optional administration without starting an engine.
 * @param _ctx - Owning plugin context.
 * @param _config - Explicit activation and resource bounds, or inert empty configuration.
 */
export function apply(_ctx: Context, _config: Config): void | Promise<() => Promise<void>> {
  const startup = _ctx.effect(() => mountAdmin(_ctx, _config))
  if (process.platform === 'win32') return Promise.resolve(startup)
}
export { waitForPrivateFiles, PrivateFilesWaitCancelled, isPrivateFilesContextActive } from './private-files-ready.ts'
export type * from './execution.ts'
export { createHostAdminExecutor, hostAdminExecutionAdapter } from './executor.ts'
export { WindowsPrivateFiles } from './windows-private-files.ts'
export type { WindowsPrivateFilesOptions } from './windows-private-files.ts'
export type { WindowsPrivateFilesExecutor } from './windows-private-files-system.ts'
export { LoopbackConnectionError, LoopbackHostMismatchError, isLoopbackAuthority } from './loopback.ts'
export type { LoopbackHostMismatch, LoopbackHostPolicy } from './loopback.ts'
