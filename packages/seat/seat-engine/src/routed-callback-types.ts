/** Structural consumer ports keep the engine independent of transport providers. */
import type * as T from '@panedesk/dsh-seat'

/** Frozen method payloads use the shared seat vocabulary, not a transport package dependency. */
export type CallbackChainRequest = { [M in T.NodeWorkChainMethod]: {
  version: 'node-link/v1'
  requestId: T.NodeWorkChainRequestId
  sourceNodeId: T.SeatNodeId
  targetNodeId: T.SeatNodeId
  operationId: T.SeatOperationId
  deadline: T.SeatTimestamp
  hop: 1
  method: M
  payload: T.NodeWorkChainMethodMap[M]['request']
  payloadDigest: T.SeatDigest
  delegation: T.SeatNodeDelegation
} }[T.NodeWorkChainMethod]

/** Only method results and safe failure fields are consumed by the callback sender. */
export type CallbackChainResponse = { [M in T.NodeWorkChainMethod]: { method: M } & (
  { status: 'ok'; result: T.NodeWorkChainMethodMap[M]['result'] }
  | { status: 'unavailable' | 'rejected' | 'uncertain'; error: Pick<T.SeatFailure, 'code' | 'retryable' | 'effectState' | 'cause'> }
) }[T.NodeWorkChainMethod]

/** Optional transport capability, resolved from Cordis separately on every attempt. */
export interface CallbackRouterPort {
  /** Route one frozen request with independently issued authority.
   * @param request - Original method and exact payload.
   * @param authorization - Fresh matching entry grant.
   * @returns Owner result or safe transport failure.
   */
  route(request: CallbackChainRequest, authorization: T.SeatAuthorizationGrant): Promise<CallbackChainResponse>
  /** Reconcile retained transport intents with restricted authority.
   * @param issuerFor - Exact durable-intent owner.
   * @returns Completion of transport recovery.
   */
  recover?(issuerFor: (request: CallbackChainRequest) => Promise<T.SeatAuthorizationIssuer | undefined>): Promise<void>
}

/** Composition owns restricted signing; the engine never manufactures reusable authority. */
export interface CallbackIssuerPort {
  /** Resolve an issuer for the original persisted callback only.
   * @param request - Original callback request, including frozen destination.
   * @returns Restricted issuer or absence.
   */
  outboxIssuer?(request: CallbackChainRequest): Promise<T.SeatAuthorizationIssuer | undefined>
}
