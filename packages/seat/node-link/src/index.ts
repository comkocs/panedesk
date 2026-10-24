/** Optional node transport definitions; this plugin opens no links or listeners. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'
import type { SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'

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
/** Loader identity does not activate transport by import. */
export const name = 'node-link'
/** Empty skeleton has no mandatory services. */
export const inject: string[] = []
/** The skeleton accepts no deployment options and performs no I/O. */
export interface Config { }
/** Empty configuration avoids introducing implicit network defaults. */
export const Config: Schema<Config> = Schema.object({})
/** Mount an inert plugin; implementations are installed separately.
 * @param _ctx - Owning plugin context.
 * @param _config - Empty skeleton configuration.
 */
export function apply(_ctx: Context, _config: Config): void {}
