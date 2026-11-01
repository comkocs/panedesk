/** Structural consumer ports keep the engine independent of transport providers. */
import type * as T from '@panedesk/dsh-seat'
import { validCallbackDiagnostic } from './validation.ts'
import { rejected } from './triggers.ts'

/** Internal callback consumption carries observations without changing wire results. */
export type CallbackAttempt = T.SeatCallbackAttemptResult<T.DeliverSourceCallbackResult> & {
  /** A definite pending query observed behind an unresolved send barrier; never permits resend. */
  queryOnly?: true
  /** The original business dispatch returned a matching receipt, not merely a query observation. */
  completedDispatch?: true
}

/** Construct a fixed safe observation without copying dynamic exception text.
 * @param body - Retained callback identity.
 * @param stage - Last verifiable failure hop.
 * @param reason - Fixed safe explanation owned by the caller.
 * @param code - Existing refusal category.
 * @param effectState - Conservative business effect bound.
 * @param reasonCode - Existing diagnostic refinement.
 * @returns Refusal and its bounded diagnostic.
 */
export function callbackFailure(body: T.DeliverSourceCallbackRequest, stage: T.SeatCallbackFailureStage,
  reason: string, code: T.SeatErrorCode = 'unavailable', effectState: T.SeatFailure['effectState'] = 'none',
  reasonCode: T.NodeWorkChainReasonCode = 'hello-policy-not-ready'):
T.SeatCallbackAttemptResult<T.SeatRejected> & { diagnostic: T.SeatCallbackDiagnostic } {
  const result = rejected(code, reason)
  const cause: T.SeatFailureCause = { domain: 'seat-callback', code, reason, effectState,
    retryable: code === 'unavailable' && effectState === 'none', operationId: body.route.originalOperationId,
    nodeId: body.callback.nodeId, reasonCode }
  return { result: { ...result, error: { ...result.error, effectState, retryable: cause.retryable, cause } },
    diagnostic: { stage, cause } }
}

/** Retain valid original causes and reject unrelated or malformed diagnostic attribution.
 * @param body - Original callback and permitted endpoint identities.
 * @param attempt - Result with an optional provider observation.
 * @param stage - Known hop when an older refusal omits a diagnostic.
 * @returns One bounded observation; invalid diagnostics never reduce uncertain effects.
 */
export function callbackObservation<R extends T.NodeWorkChainOperationResult | T.DeliverSourceCallbackResult>(
  body: T.DeliverSourceCallbackRequest, attempt: T.SeatCallbackAttemptResult<R>,
  stage: T.SeatCallbackFailureStage): T.SeatCallbackAttemptResult<R> {
  const result = attempt.result
  const error = 'error' in result ? result.error : undefined
  const pending = result.status === 'pending' && result.pendingReason
    ? callbackFailure(body, stage, 'Callback owner has not confirmed completion', 'unavailable', 'unknown', 'outcome-unknown').diagnostic : undefined
  if (pending && result.status === 'pending') pending.cause.code = `callback-${result.pendingReason}`
  const diagnostic = attempt.diagnostic ?? pending ?? (error?.cause ? { stage, cause: error.cause }
    : error ? callbackFailure(body, stage, 'Callback attempt was refused', error.code, error.effectState, 'evidence-missing').diagnostic : undefined)
  if (!diagnostic) return attempt
  if (validCallbackDiagnostic(diagnostic) && diagnostic.cause.operationId === body.route.originalOperationId
    && [body.callback.nodeId, body.route.sourceOwnerNodeId].includes(diagnostic.cause.nodeId)) return { result, diagnostic }
  return { result, diagnostic: callbackFailure(body, stage, 'Callback diagnostic was invalid', 'callback-protocol-error',
    error?.effectState === 'unknown' || diagnostic.cause.effectState === 'unknown' ? 'unknown' : 'none', 'invalid-diagnostic').diagnostic }
}

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
