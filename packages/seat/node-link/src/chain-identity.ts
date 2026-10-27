/** Chain identity binds transport records to the complete business key. */
import type { NodeWorkChainOperationKey, NodeWorkChainReasonCode } from '@panedesk/dsh-seat'
import type { ChainRequest, ChainResponse } from './chain-types.ts'
import type { NodeLinkErrorCode } from './index.ts'

/** Derive the business key without changing operation or callback identifiers.
 * @param request - Validated authenticated chain request.
 * @returns Exact business key; a query retains the requested original key.
 */
export function chainKey(request: ChainRequest): NodeWorkChainOperationKey {
  if (request.method === 'chain.operation') return request.payload.key
  if (request.method === 'seat.definitionRevision') throw new Error('Node chain observation has no business key')
  const source = request.method === 'source.prepareOpening' ? request.payload : request.payload.route
  return { sourceNodeId: request.sourceNodeId, principalId: request.delegation.principalId,
    sourceId: source.sourceId, ownerEpoch: source.ownerEpoch, method: request.method,
    operationId: request.operationId,
    ...(request.method === 'source.deliverCallback' ? { callbackId: request.payload.callback.callbackId } : {}) }
}

/** Encode every key component in a fixed order, with no delimiter ambiguity.
 * @param key - Exact business operation identity.
 * @returns Stable lookup key independent of property insertion order.
 */
export function chainKeyText(key: NodeWorkChainOperationKey): string {
  return JSON.stringify([key.sourceNodeId, key.principalId, key.sourceId, key.ownerEpoch,
    key.method, key.operationId, key.callbackId ?? null])
}

/** Construct bounded diagnostics without exposing caught exceptions or addresses.
 * @param request - Exact call identity.
 * @param code - Existing compatibility category.
 * @param reasonCode - Frozen safe diagnostic.
 * @param unknown - Whether an effect may already have happened.
 * @returns Correlated refusal with a structured cause.
 */
export function chainFailure(request: ChainRequest, code: NodeLinkErrorCode, reasonCode: NodeWorkChainReasonCode,
  unknown = false): ChainResponse {
  const effectState = unknown ? 'unknown' : 'none'
  const retryable = code === 'node-tunnel-disconnected'
  const reason = request.method === 'seat.definitionRevision' && reasonCode === 'peer-capability-missing'
    ? 'Both nodes must advertise seat-definition-revision/v1 before an exact revision read.' : reasonCode
  return { version: request.version, requestId: request.requestId, operationId: request.operationId,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, method: request.method,
    status: unknown ? 'uncertain' : code === 'node-delegation-rejected' || code === 'node-operation-conflict' ? 'rejected' : 'unavailable',
    error: { code, reason, retryable, effectState, operationId: request.operationId, targetNodeId: request.targetNodeId,
      cause: { domain: 'node-link', code, reason, reasonCode, effectState, retryable,
        operationId: request.operationId, nodeId: request.targetNodeId } } }
}

/** Identify the two local transport refusals retained by legacy sending stores.
 * @param response - Correlated transport receipt, absent for an unresolved intent.
 * @returns Whether the receipt represents expiry or connection failure without an owner result.
 */
export function chainTransportNone(response: ChainResponse | undefined): boolean {
  return response !== undefined && response.status === 'unavailable' && response.error.effectState === 'none'
    && ((response.error.code === 'node-deadline-exceeded' && response.error.cause.reasonCode === 'deadline-exceeded')
      || (response.error.code === 'node-tunnel-disconnected' && response.error.cause.reasonCode === 'tunnel-disconnected'))
}

/** Only callback delivery may recover a local refusal; every response-less intent remains queryable.
 * @param method - Original admitted business method, never the recovery query method.
 * @param response - Retained receipt, absent for an unresolved intent.
 * @returns Whether method and receipt permit recovery, subject to retained owner-evidence exclusion.
 */
export function chainRecoveryEligible(method: ChainRequest['method'], response: ChainResponse | undefined): boolean {
  return response === undefined || (method === 'source.deliverCallback' && chainTransportNone(response))
}

/** Pending business stages never become permanent transport settlements.
 * @param response - Validated chain response.
 * @returns Whether the receipt must remain queryable rather than terminal.
 */
export function chainPending(response: ChainResponse): boolean {
  if (response.status !== 'ok') return response.error.effectState === 'unknown'
  return response.result.status === 'pending' || response.result.status === 'unknown'
}
