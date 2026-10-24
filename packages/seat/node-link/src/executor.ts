/** Node execution stays local and requires an atomic admission owner for audited seat writes. */
import type { NodeLinkExecutionAdapter, NodeLinkExecutionDependencies } from './execution.ts'
import type { NodeLinkExecutor } from './index.ts'
import { NODE_LINK_VERSION } from './index.ts'
import { failure } from './receiver.ts'
import { decodeRequest, decodeResponse } from './codec.ts'

/** Compose receiving policy with local-only execution capabilities.
 * @param dependencies - Local providers and trusted journal admission owner.
 * @returns Executor that rechecks authority for every retry and before execution.
 */
export function createNodeLinkExecutor(dependencies: NodeLinkExecutionDependencies): NodeLinkExecutor {
  const authorize: NodeLinkExecutor['authorize'] = async (input) => {
    const request = decodeRequest(input)
    if (request.targetNodeId !== dependencies.nodeId) return false
    const issuer = await dependencies.policy.authorize(request, dependencies.peer)
    if ('code' in issuer) return false
    const grant = await issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest,
      ...(request.method === 'messages.send' && request.payload.delivery.callId ? { callId: request.payload.delivery.callId } : {}),
      ...(request.method === 'messages.send' && request.payload.delivery.rootCallId ? { rootCallId: request.payload.delivery.rootCallId } : {}) })
    return !('status' in grant) && grant.fact.decision === 'allowed'
      && grant.fact.kind === 'node-delegation' && grant.fact.nodeId === dependencies.nodeId
      && grant.fact.operationId === request.operationId && grant.fact.requestDigest === request.payloadDigest
      && grant.fact.delegatedBy === request.delegation.authorizationRef
      && grant.fact.principalId === request.delegation.principalId
      && grant.fact.seat === request.delegation.seat && grant.fact.sessionId === request.delegation.sessionId
      && grant.fact.taskIds.every(task => request.delegation.taskIds.includes(task))
  }
  return { authorize, status: async () => {
    if (!dependencies.localSeats.nodeStatus) throw new Error('Local node status unavailable')
    return dependencies.localSeats.nodeStatus()
  }, execute: async (input) => {
    const request = decodeRequest(input)
    if (request.targetNodeId !== dependencies.nodeId) return failure(request, 'node-delegation-rejected')
    const issuer = await dependencies.policy.authorize(request, dependencies.peer)
    if ('code' in issuer) return failure(request, 'node-delegation-rejected')
    const grant = await issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest,
      ...(request.method === 'messages.send' && request.payload.delivery.callId ? { callId: request.payload.delivery.callId } : {}),
      ...(request.method === 'messages.send' && request.payload.delivery.rootCallId ? { rootCallId: request.payload.delivery.rootCallId } : {}) })
    if ('status' in grant || grant.fact.decision !== 'allowed' || grant.fact.kind !== 'node-delegation'
      || grant.fact.nodeId !== dependencies.nodeId || grant.fact.operationId !== request.operationId
      || grant.fact.requestDigest !== request.payloadDigest || grant.fact.delegatedBy !== request.delegation.authorizationRef
      || grant.fact.principalId !== request.delegation.principalId
      || grant.fact.seat !== request.delegation.seat || grant.fact.sessionId !== request.delegation.sessionId
      || grant.fact.taskIds.some(task => !request.delegation.taskIds.includes(task))) {
      return failure(request, 'node-delegation-rejected')
    }
    if (request.method === 'messages.send') {
      const sender = request.payload.delivery.message.sender
      if ((sender.kind === 'session' && grant.fact.sessionId !== sender.sessionId)
        || (sender.kind === 'human' && grant.fact.sessionId !== undefined)) return failure(request, 'node-delegation-rejected')
      if (!dependencies.messages || !dependencies.messageAuthority) return failure(request, 'cross-node-unsupported')
      const authority = await dependencies.messageAuthority.authorize(request.payload.delivery)
      if (!authority || authority.sourceNodeId !== request.sourceNodeId || authority.targetNodeId !== request.targetNodeId) {
        return failure(request, 'node-delegation-rejected')
      }
      return { version: NODE_LINK_VERSION, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method, status: 'ok',
        result: await dependencies.messages.receive(request.payload, authority) }
    }
    if (request.method === 'seat.operation') {
      const local = dependencies.localSeats.withAuthority({ principalId: grant.fact.principalId, origin: grant.fact.origin,
        nodeId: dependencies.nodeId, authorization: grant })
      return { version: NODE_LINK_VERSION, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method, status: 'ok',
        result: await local.operation(request.payload) }
    }
    if (!dependencies.localAdmission) return failure(request, 'cross-node-unsupported')
    return decodeResponse(await dependencies.localAdmission.execute(request, grant), request)
  } }
}
/** Host composition uses this factory without activating routing by import. */
export const nodeLinkExecutionAdapter: NodeLinkExecutionAdapter = { create: createNodeLinkExecutor }
