/** Receiving seat writes retain the local provider's original transactional admission. */
import type * as T from '@panedesk/dsh-seat'
import { NODE_LINK_VERSION, type NodeAuthorizedLocalAdmission, type NodeWireResponse } from '@panedesk/dsh-node-link'

/** Capture the local provider without exposing a route-capable caller to the receiver.
 * @param seats - Original local provider with audited action builders.
 * @param nodeId - Journal-owning node.
 * @param batch - Optional recovered chain admission; omission preserves legacy refusal.
 * @returns Admission adapter; unsupported atomic actions remain explicitly refused.
 */
export function createLocalNodeAdmission(seats: T.SeatService, nodeId: T.SeatNodeId,
  batch?: (request: T.OpenSeatBatchRequest, authority: T.SeatCallContext,
    sourceNodeId: T.SeatNodeId) => Promise<T.OpenSeatBatchResult | undefined>,
): NodeAuthorizedLocalAdmission {
  return { execute: async (request, authorization): Promise<NodeWireResponse> => {
    const base = { version: NODE_LINK_VERSION, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
      targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method }
    if (request.targetNodeId !== nodeId || authorization.fact.kind !== 'node-delegation'
      || authorization.fact.nodeId !== nodeId || authorization.fact.operationId !== request.operationId
      || authorization.fact.requestDigest !== request.payloadDigest) {
      return { ...base, status: 'rejected', error: { code: 'node-delegation-rejected',
        reason: 'Local admission identity mismatch', retryable: false, effectState: 'none', operationId: request.operationId, targetNodeId: nodeId } }
    }
    const local = seats.withAuthority({ principalId: authorization.fact.principalId, origin: authorization.fact.origin,
      nodeId, authorization })
    if (request.method === 'seat.openBatch' && batch) {
      const result = await batch(request.payload, { principalId: authorization.fact.principalId,
        origin: authorization.fact.origin, nodeId, authorization }, request.sourceNodeId)
      if (result !== undefined) return { ...base, method: request.method, status: 'ok', result }
    }
    switch (request.method) {
      case 'seat.open': return { ...base, method: request.method, status: 'ok', result: await local.open(request.payload) }
      case 'seat.renew': return { ...base, method: request.method, status: 'ok', result: await local.renew(request.payload) }
      case 'seat.close': return { ...base, method: request.method, status: 'ok', result: await local.close(request.payload) }
      case 'seat.replace': return { ...base, method: request.method, status: 'ok', result: await local.replace(request.payload) }
      default: return { ...base, status: 'rejected', error: { code: 'cross-node-unsupported',
        reason: 'The action has no atomic local admission', retryable: false, effectState: 'none', operationId: request.operationId, targetNodeId: nodeId } }
    }
  } }
}
