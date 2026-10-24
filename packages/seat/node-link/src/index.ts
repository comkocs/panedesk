/** Optional node transport definitions and runtime; links require explicit configuration. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'
import type { SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import type { PrivateFiles } from '@panedesk/dsh-host-admin'
import { mountNode } from './runtime.ts'

/** Wire framing is independent of Core protocol operation numbers. */
export const NODE_LINK_VERSION = 'node-link/v1' as const
/** Absent routing retains the existing rejection; disconnected links never queue new user calls. */
export const NODE_LINK_ERROR_CODES = {
  'cross-node-unsupported': true, 'node-tunnel-disconnected': true,
  'node-authentication-failed': true, 'node-protocol-mismatch': true,
  'node-deadline-exceeded': true, 'node-outcome-unknown': true,
  'node-delegation-rejected': true, 'node-operation-conflict': true,
} as const
/** Transport failures distinguish known non-execution from an unknown outcome. */
export type NodeLinkErrorCode = keyof typeof NODE_LINK_ERROR_CODES
/** Existing request/result definitions remain the authority for operation semantics. */
export interface NodeRouteMethods {
  'seat.open': { request: Seat.OpenSeatRequest; result: Seat.OpenSeatResult }
  'seat.openBatch': { request: Seat.OpenSeatBatchRequest; result: Seat.OpenSeatBatchResult }
  'seat.renew': { request: Seat.RenewSeatRequest; result: Seat.RenewSeatResult }
  'seat.close': { request: Seat.CloseSeatRequest; result: Seat.CloseSeatResult }
  'seat.replace': { request: Seat.ReplaceSeatRequest; result: Seat.ReplaceSeatResult }
  'seat.wake': { request: Seat.WakeSeatRequest; result: Seat.WakeSeatResult }
  'messages.send': { request: SendMessageRequest; result: SendMessageResult }
  'seat.operation': { request: Seat.SeatOperationQuery; result: Seat.SeatOperationResult }
}
/** Mapped frames retain method/payload correlation and prohibit arbitrary RPC forwarding. */
export type NodeWireRequest = { [K in keyof NodeRouteMethods]: {
  version: typeof NODE_LINK_VERSION
  requestId: Branded<'NodeRequestId'>
  sourceNodeId: Seat.SeatNodeId
  targetNodeId: Seat.SeatNodeId
  operationId: Seat.SeatOperationId
  deadline: Seat.SeatTimestamp
  hop: 1
  method: K
  payload: NodeRouteMethods[K]['request']
  payloadDigest: Seat.SeatDigest
  delegation: Seat.SeatNodeDelegation
} }[keyof NodeRouteMethods]
/** Safe failures contain aliases and audit references, never credentials or network locations. */
export interface NodeLinkFailure {
  code: NodeLinkErrorCode
  reason: string
  retryable: boolean
  effectState: 'none' | 'unknown'
  operationId: Seat.SeatOperationId
  targetNodeId: Seat.SeatNodeId
}
/** Responses echo the initiator identity; accepted does not imply model completion. */
export type NodeWireResponse = { [K in keyof NodeRouteMethods]: {
  version: typeof NODE_LINK_VERSION
  requestId: Branded<'NodeRequestId'>
  operationId: Seat.SeatOperationId
  sourceNodeId: Seat.SeatNodeId
  targetNodeId: Seat.SeatNodeId
  method: K
} & ({ status: 'ok'; result: NodeRouteMethods[K]['result'] } | { status: 'unavailable' | 'rejected' | 'uncertain'; error: NodeLinkFailure }) }[keyof NodeRouteMethods]
/** Stale or unreachable nodes never report invented zero-window counts. */
export interface NodeLinkStatus {
  nodeId: Seat.SeatNodeId
  nodeName: string
  reachable: boolean
  linkState: 'connected' | 'disconnected' | 'connecting' | 'stale'
  observedAt: Seat.SeatTimestamp
  status: Seat.SeatNodeStatus | null
  capabilities: readonly string[]
  safeReason: string | null
}
/** Receiver invokes local providers only; delegation is authenticated again and cannot add hops. */
export interface NodeRouterService {
  /** Route one bounded authenticated request without offline user-operation queues.
   * @param request - Fixed method, digest, deadline and narrowed delegation.
   * @returns Target result or explicit unknown outcome retaining operation identity.
   */
  route(request: NodeWireRequest): Promise<NodeWireResponse>
  /** Read dated health without initiating a model or opening a window.
   * @returns Node aliases and explicit stale/unreachable evidence.
   */
  status(): Promise<readonly NodeLinkStatus[]>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Optional router; absence retains local behavior and cross-node-unsupported. */
    nodeRouter: NodeRouterService
  }
}
/** Local provider narrows authenticated node delegations and never calls a router again. */
export interface NodeLinkExecutor {
  /** Check the current binding, principal, target and method rights on the receiving node.
   * @param request - Validated request authenticated to its configured source node.
   * @returns Whether current local policy permits this exact delegation.
   */
  authorize(request: NodeWireRequest): Promise<boolean>
  /** Execute through the original local provider after durable transport admission.
   * @param request - Authorized fixed-method operation.
   * @returns Correlated local provider result.
   */
  execute(request: NodeWireRequest): Promise<NodeWireResponse>
  /** Observe current local capacity without starting an engine.
   * @returns Local node self-report.
   */
  status(): Promise<Seat.SeatNodeStatus>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Missing executor rejects ingress rather than bypassing authorization or routing again. */
    nodeLinkExecutor: NodeLinkExecutor
    /** Windows deployments must supply account-scoped ACL and path verification. */
    nodeLinkFiles: (directory: string) => PrivateFiles
  }
}

/** Loader identity does not activate transport by import. */
export const name = 'node-link'
/** Empty skeleton has no mandatory services. */
export const inject: string[] = []
/** Explicit paired ports use preprovisioned independent inbound/outbound credential files. */
export interface NodeLinkRuntimeConfig {
  nodeId: string
  peerNodeId: string
  peerName: string
  directory: string
  listenPort: number
  peerPort: number
  maxFrameBytes: number
  requestTimeoutMs: number
  maxPending: number
  maxStoreBytes: number
  maxOperations: number
  staleMs: number
  ssh?: {
    alias: string
    cwd: string
    remotePort: number
    remoteTargetPort: number
    graceMs: number
    keepAliveSeconds: number
    keepAliveCount: number
    retryMs: number
    maxRetries: number
  } | undefined
}
/** Omission preserves the empty plugin's no-I/O behavior. */
export interface Config { runtime?: NodeLinkRuntimeConfig | undefined }
/** All listener, persistence and supervision limits are explicit deployment choices. */
export const Config: Schema<Config> = Schema.object({ runtime: Schema.union([Schema.const(undefined), Schema.object({
  nodeId: Schema.string().required(), peerNodeId: Schema.string().required(), peerName: Schema.string().required(),
  directory: Schema.string().required(), listenPort: Schema.number().min(0).max(65535).step(1).required(),
  peerPort: Schema.number().min(1).max(65535).step(1).required(),
  maxFrameBytes: Schema.number().min(1).step(1).required(), requestTimeoutMs: Schema.number().min(1).max(2147483647).step(1).required(),
  maxPending: Schema.number().min(1).step(1).required(), maxStoreBytes: Schema.number().min(1).step(1).required(),
  maxOperations: Schema.number().min(1).step(1).required(), staleMs: Schema.number().min(1).step(1).required(),
  ssh: Schema.union([Schema.const(undefined), Schema.object({ alias: Schema.string().required(), cwd: Schema.string().required(),
    remotePort: Schema.number().min(1).max(65535).step(1).required(),
    remoteTargetPort: Schema.number().min(1).max(65535).step(1).required(),
    graceMs: Schema.number().min(1).step(1).required(), keepAliveSeconds: Schema.number().min(1).step(1).required(),
    keepAliveCount: Schema.number().min(1).step(1).required(), retryMs: Schema.number().min(1).step(1).required(),
    maxRetries: Schema.number().min(0).step(1).required(),
  })]),
})]) })
/** Mount only explicitly configured transport; absent options remain inert.
 * @param _ctx - Owning plugin context.
 * @param _config - Optional runtime activation and resource bounds.
 */
export function apply(_ctx: Context, _config: Config): void { _ctx.effect(() => mountNode(_ctx, _config)) }
