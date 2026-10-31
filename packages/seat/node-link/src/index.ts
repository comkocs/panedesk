/** Optional node transport definitions and runtime; links require explicit configuration. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'
import type { SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import { isLoopbackAuthority, isPrivateFilesContextActive, type PrivateFiles } from '@panedesk/dsh-host-admin'
import { mountChangingNode } from './chain-attachment.ts'
import { ChainBusinessRegistry } from './chain-business.ts'

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
  'messages.sendSeat': { request: import('@panedesk/dsh-message-delivery').RoutedSeatMessageRequest; result: SendMessageResult }
  'messages.onlineSeats': { request: import('@panedesk/dsh-message-delivery').OnlineSeatsRequest; result: readonly import('@panedesk/dsh-message-delivery').OnlineSeat[] }
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
/** One process-local observation never contains transport locations or credentials. */
export interface NodeLinkEvent {
  sequence: number
  at: Seat.SeatTimestamp
  kind: 'connected' | 'disconnected' | 'reconnecting' | 'exhausted' | 'rebuild' | 'authentication-succeeded' | 'authentication-failed'
  safeReason: string | null
}
/** Stale or unreachable nodes never report invented zero-window counts. */
export interface NodeLinkStatus {
  /** Last successful authenticated round trip; null until the first success, absent on older providers. */
  lastHeartbeatAt?: Seat.SeatTimestamp | null
  /** Latest twenty observations since this process started; absent on older providers. */
  events?: readonly NodeLinkEvent[]
  /** True only after the local transport exhausts its retry budget; absent on older providers. */
  exhausted?: boolean
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
   * @param recovery - Trusted local recovery intent and current sender lifetime, never wire authority.
   * @returns Target result or explicit unknown outcome retaining operation identity.
   */
  route(request: NodeWireRequest, recovery?: { reconcile: boolean; active: () => boolean }): Promise<NodeWireResponse>
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
  /** Identity of the local node. */
  nodeId: string
  /** Expected authenticated identity of the paired node. */
  peerNodeId: string
  /** Display name retained with peer health evidence. */
  peerName: string
  /** Exclusive absolute directory for directional credentials and operation records. */
  directory: string
  /** Local loopback listener port; zero allocates an ephemeral port. */
  listenPort: number
  /** Local loopback port reaching the paired node through the supervised forward. */
  peerPort: number
  /** Exact additional loopback Host authorities; omission or an empty list accepts only the actual listener authority. */
  forwardedHosts?: string[] | undefined
  /** Maximum bytes in a complete request or response frame. */
  maxFrameBytes: number
  /** Maximum time in milliseconds to wait for a transport response. */
  requestTimeoutMs: number
  /** Maximum number of concurrent transport requests. */
  maxPending: number
  /** Maximum bytes in each durable operation store. */
  maxStoreBytes: number
  /** Maximum retained operation records before new operations reject. */
  maxOperations: number
  /** Milliseconds after the last successful health probe before status becomes stale. */
  staleMs: number
  /** Maximum prior-epoch overlap in milliseconds; omission disables overlap. */
  credentialOverlapMs?: number | undefined
  /** Optional supervised OpenSSH forwarding through an existing reviewed host alias. */
  ssh?: {
    /** Existing simple SSH host alias, never a command or arbitrary option. */
    alias: string
    /** Working directory of the supervised SSH child process. */
    cwd: string
    /** Remote loopback port forwarding back to the local listener. */
    remotePort: number
    /** Remote loopback listener reached by the local forward. */
    remoteTargetPort: number
    /** Milliseconds allowed for graceful child termination before escalation. */
    graceMs: number
    /** SSH server-alive interval in seconds. */
    keepAliveSeconds: number
    /** Maximum unanswered SSH server-alive probes. */
    keepAliveCount: number
    /** Milliseconds between supervised connection attempts. */
    retryMs: number
    /** Maximum reconnection attempts after the initial attempt. */
    maxRetries: number
    /** Optional OpenSSH configuration file. Omission keeps the user's default configuration. */
    sshConfigFile?: string | undefined
  } | undefined
}
/** Omission preserves the empty plugin's no-I/O behavior. */
export interface Config {
  /** Explicit activation, node identities and transport resource bounds. */
  runtime?: NodeLinkRuntimeConfig | undefined
}
/** All listener, persistence and supervision limits are explicit deployment choices. */
export const Config: Schema<Config> = Schema.object({ runtime: Schema.union([Schema.const(undefined), Schema.object({
  nodeId: Schema.string().required(), peerNodeId: Schema.string().required(), peerName: Schema.string().required(),
  directory: Schema.string().required(), listenPort: Schema.number().min(0).max(65535).step(1).required(),
  peerPort: Schema.number().min(1).max(65535).step(1).required(),
  forwardedHosts: Schema.union([Schema.const(undefined), Schema.array(Schema.transform(Schema.string(), (value) => {
    if (!isLoopbackAuthority(value)) throw new Error('Forwarded Host rejected')
    return value
  }))]),
  maxFrameBytes: Schema.number().min(1).step(1).required(), requestTimeoutMs: Schema.number().min(1).max(2147483647).step(1).required(),
  maxPending: Schema.number().min(1).step(1).required(), maxStoreBytes: Schema.number().min(1).step(1).required(),
  maxOperations: Schema.number().min(1).step(1).required(), staleMs: Schema.number().min(1).step(1).required(),
  credentialOverlapMs: Schema.union([Schema.const(undefined), Schema.number().min(0).max(2147483647).step(1)]),
  ssh: Schema.union([Schema.const(undefined), Schema.object({ alias: Schema.string().required(), cwd: Schema.string().required(),
    remotePort: Schema.number().min(1).max(65535).step(1).required(),
    remoteTargetPort: Schema.number().min(1).max(65535).step(1).required(),
    graceMs: Schema.number().min(1).step(1).required(), keepAliveSeconds: Schema.number().min(1).step(1).required(),
    keepAliveCount: Schema.number().min(1).step(1).required(), retryMs: Schema.number().min(1).step(1).required(),
    maxRetries: Schema.number().min(0).step(1).required(),
    sshConfigFile: Schema.union([Schema.const(undefined), Schema.string()]),
  })]),
})]) })
/** Mount only explicitly configured transport; absent options remain inert.
 * @param _ctx - Owning plugin context.
 * @param _config - Optional runtime activation and resource bounds.
 */
export function apply(_ctx: Context, _config: Config): void | Promise<() => Promise<void>> {
  if (process.platform === 'win32' && _config.runtime !== undefined) {
    return Promise.resolve(_ctx.effect(async () => {
      await _ctx.plugin({ name: 'node-link-business', apply(owner: Context) {
        owner.provide('nodeWorkChainBusiness', new ChainBusinessRegistry())
      } })
      if (!isPrivateFilesContextActive(_ctx)) return async () => {}
      return mountChangingNode(_ctx, _config, true)
    }))
  }
  if (_config.runtime !== undefined) _ctx.provide('nodeWorkChainBusiness', new ChainBusinessRegistry())
  _ctx.effect(() => mountChangingNode(_ctx, _config))
}
export type * from './delegation.ts'
export type * from './execution.ts'
export type * from './chain-services.ts'
export type * from './chain-types.ts'
export { createDelegationIssuer, createDelegationReceivingPolicy } from './delegation-policy.ts'
export type { DelegationEvidence, DelegationIssuanceOptions, DelegationReceivingOptions } from './delegation-policy.ts'
export { createNodeLinkExecutor, nodeLinkExecutionAdapter } from './executor.ts'
export { decodeRoutedSend } from './routed-codec.ts'
export { decodeRoutedSeatSend } from './seat-message-codec.ts'
