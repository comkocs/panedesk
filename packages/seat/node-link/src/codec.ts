/** Wire validation binds payloads, delegations and replies to one target operation. */
import { decodeSeatRequest, decodeSeatResult, decodeMessagesRequest, decodeMessagesResult } from '@panedesk/dsh-sdk-protocol'
import { digest, object, identifier } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION, NODE_LINK_ERROR_CODES } from './index.ts'
import type { NodeWireRequest, NodeWireResponse, NodeRouteMethods } from './index.ts'

const methods = { 'seat.open': 'seats/open', 'seat.openBatch': 'seats/openBatch', 'seat.renew': 'seats/renew',
  'seat.close': 'seats/close', 'seat.replace': 'seats/replace', 'seat.wake': 'seats/wake', 'seat.operation': 'seats/operation' } as const

/** Decode the complete frame before authentication-derived delegation narrowing.
 * @param value - Parsed bounded JSON.
 * @returns Validated request without granting authority from its strings.
 */
export function decodeRequest(value: unknown): NodeWireRequest {
  if (!object(value) || value.version !== NODE_LINK_VERSION || !identifier(value.requestId)
    || !identifier(value.sourceNodeId) || !identifier(value.targetNodeId) || value.sourceNodeId === value.targetNodeId
    || !identifier(value.operationId) || value.hop !== 1 || typeof value.deadline !== 'string'
    || !Number.isFinite(Date.parse(value.deadline)) || typeof value.method !== 'string'
    || (value.method !== 'messages.send' && !Object.hasOwn(methods, value.method))
    || typeof value.payloadDigest !== 'string' || value.payloadDigest !== digest(value.payload)
    || Object.keys(value).some(key => !['version', 'requestId', 'sourceNodeId', 'targetNodeId', 'operationId',
      'deadline', 'hop', 'method', 'payload', 'payloadDigest', 'delegation'].includes(key))) throw new Error('Node frame rejected')
  if (value.method === 'messages.send') decodeMessagesRequest('messages/send', value.payload)
  else decodeSeatRequest(methods[value.method as keyof typeof methods], value.payload)
  const delegation = value.delegation
  if (!object(delegation) || delegation.kind !== 'node-delegation' || delegation.hop !== 1
    || !identifier(delegation.principalId) || !identifier(delegation.authorizationRef)
    || delegation.sourceNodeId !== value.sourceNodeId || delegation.targetNodeId !== value.targetNodeId
    || delegation.operationId !== value.operationId || delegation.requestDigest !== value.payloadDigest
    || typeof delegation.expiresAt !== 'string' || !Number.isFinite(Date.parse(delegation.expiresAt))
    || !Array.isArray(delegation.taskIds) || !delegation.taskIds.every(identifier)
    || (delegation.seat !== undefined && !identifier(delegation.seat))
    || (delegation.sessionId !== undefined && !identifier(delegation.sessionId))
    || Object.keys(delegation).some(key => !['kind', 'hop', 'principalId', 'authorizationRef', 'sourceNodeId', 'targetNodeId',
      'operationId', 'requestDigest', 'expiresAt', 'taskIds', 'seat', 'sessionId'].includes(key))) throw new Error('Node delegation rejected')
  if (!object(value.payload) || (value.method !== 'seat.operation' && value.payload.operationId !== value.operationId)
    || (value.payload.nodeId !== undefined && value.payload.nodeId !== value.targetNodeId)) throw new Error('Node payload identity rejected')
  return value as NodeWireRequest
}

/** Validate result semantics with the existing provider codec.
 * @param method - Fixed operation method.
 * @param result - Peer or durable result.
 * @returns Result after provider schema validation.
 */
export function decodeResult(method: keyof NodeRouteMethods, result: unknown): NodeRouteMethods[keyof NodeRouteMethods]['result'] {
  return method === 'messages.send' ? decodeMessagesResult('messages/send', result) : decodeSeatResult(methods[method], result)
}

/** Validate every echoed identity before a peer result becomes caller evidence.
 * @param value - Peer response.
 * @param request - Original frame.
 * @returns Correlated response or validation failure.
 */
export function decodeResponse(value: unknown, request: NodeWireRequest): NodeWireResponse {
  if (!object(value) || value.version !== NODE_LINK_VERSION || value.requestId !== request.requestId
    || value.operationId !== request.operationId || value.sourceNodeId !== request.sourceNodeId
    || value.targetNodeId !== request.targetNodeId || value.method !== request.method) throw new Error('Node response identity rejected')
  if (value.status === 'ok') decodeResult(request.method, value.result)
  else if (!['unavailable', 'rejected', 'uncertain'].includes(String(value.status)) || !object(value.error)
    || typeof value.error.code !== 'string' || !Object.hasOwn(NODE_LINK_ERROR_CODES, value.error.code)
    || typeof value.error.reason !== 'string' || typeof value.error.retryable !== 'boolean'
    || !['none', 'unknown'].includes(String(value.error.effectState)) || value.error.operationId !== request.operationId
    || value.error.targetNodeId !== request.targetNodeId) throw new Error('Node failure rejected')
  return value as NodeWireResponse
}
