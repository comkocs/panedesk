/** Receiver persists admission before invoking an authenticated local executor. */
import { digest, OperationStore } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION } from './index.ts'
import type { NodeLinkErrorCode, NodeLinkExecutor, NodeWireRequest, NodeWireResponse } from './index.ts'
import { decodeResponse } from './codec.ts'

/** Safe failure construction never includes credentials, paths or network diagnostics.
 * @param request - Validated operation identity.
 * @param code - Frozen transport failure.
 * @param unknown - Whether request execution may already have happened.
 * @returns Correlated explicit failure.
 */
export function failure(request: NodeWireRequest, code: NodeLinkErrorCode, unknown = false): NodeWireResponse {
  return { version: NODE_LINK_VERSION, requestId: request.requestId, operationId: request.operationId,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, method: request.method,
    status: unknown ? 'uncertain' : code === 'node-delegation-rejected' || code === 'node-operation-conflict' ? 'rejected' : 'unavailable',
    error: { code, reason: code, retryable: code === 'node-tunnel-disconnected', effectState: unknown ? 'unknown' : 'none',
      operationId: request.operationId, targetNodeId: request.targetNodeId } }
}

/** Local-only receiver never forwards an accepted operation to another node. */
export class NodeReceiver {
  constructor(private readonly nodeId: string, private readonly peerId: string,
    private readonly store: OperationStore, private readonly executor: () => NodeLinkExecutor | undefined) {}
  /** Recheck delegated authority on every delivery, including duplicate IDs.
   * @param request - Authenticated and decoded request.
   * @returns Original result or refusal; pending records are never executed twice.
   */
  async receive(request: NodeWireRequest): Promise<NodeWireResponse> {
    if (request.sourceNodeId !== this.peerId || request.targetNodeId !== this.nodeId) return failure(request, 'node-authentication-failed')
    if (Date.parse(request.deadline) <= Date.now() || Date.parse(request.delegation.expiresAt) <= Date.now()) {
      return failure(request, 'node-deadline-exceeded')
    }
    const executor = this.executor()
    if (executor === undefined) return failure(request, 'cross-node-unsupported')
    if (!await executor.authorize(request)) return failure(request, 'node-delegation-rejected')
    const key = (operationId: string): string => JSON.stringify([request.sourceNodeId, request.delegation.principalId, operationId])
    if (request.method === 'seat.operation') {
      const stored = this.store.query(key(request.payload.operationId))
      if (stored.state === 'pending') return failure(request, 'node-outcome-unknown', true)
      // Provider queries preserve their frozen result type; transport retries retrieve other method results by the same ID.
      return decodeResponse(await executor.execute(request), request)
    }
    try {
      const result = await this.store.run(key(request.operationId), digest({ method: request.method,
        payload: request.payload, principalId: request.delegation.principalId, seat: request.delegation.seat ?? null,
        sessionId: request.delegation.sessionId ?? null, taskIds: request.delegation.taskIds }), async () => {
        if (Date.parse(request.deadline) <= Date.now() || Date.parse(request.delegation.expiresAt) <= Date.now()) {
          return failure(request, 'node-deadline-exceeded')
        }
        if (!await executor.authorize(request)) return failure(request, 'node-delegation-rejected')
        return decodeResponse(await executor.execute(request), request)
      })
      if (result.state === 'conflict') return failure(request, 'node-operation-conflict')
      if (result.state !== 'settled') return failure(request, 'node-outcome-unknown', true)
      if (typeof result.result !== 'object' || result.result === null) return failure(request, 'node-outcome-unknown', true)
      return decodeResponse({ ...result.result, requestId: request.requestId }, request)
    } catch (error) { void error; return failure(request, 'node-outcome-unknown', true) }
  }
}
