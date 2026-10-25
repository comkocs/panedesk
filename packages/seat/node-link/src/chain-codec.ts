/** Strict opt-in wire decoding preserves the legacy codec and digest rules. */
import { digest, identifier, object } from '@panedesk/dsh-host-admin'
import { decodeNodeWorkChainRequest, decodeNodeWorkChainResult, decodeSeatFailureCause,
  decodeNodeDelegationEvidenceRequest, decodeNodeDelegationEvidenceResult, encodeNodeWorkChainFrame } from '@panedesk/dsh-sdk-protocol'
import type { NodeWorkChainMethod, SeatDigest } from '@panedesk/dsh-seat'
import type { ChainCapability, ChainRequest, ChainResponse, ChainEvidenceFrame, ChainEvidenceResponse } from './chain-types.ts'
import { NODE_LINK_ERROR_CODES, NODE_LINK_VERSION } from './index.ts'

const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen', 'source.prepareOpening',
  'source.checkAdmission', 'source.deliverCallback', 'chain.operation'] as const
const fields = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key))

/** Recognize only the frozen seven-method set.
 * @param value - Untrusted method discriminator.
 * @returns Whether the method belongs to the work-chain protocol.
 */
export function isChainMethod(value: unknown): value is NodeWorkChainMethod {
  return typeof value === 'string' && methods.some(method => method === value)
}

/** Callback digests exclude only their self-referential digest field.
 * @param method - Frozen method discriminator.
 * @param payload - Complete method payload.
 * @returns Canonical digest independent of envelope lifetime and request ID.
 */
export function chainDigest(method: NodeWorkChainMethod, payload: unknown): SeatDigest {
  if (method === 'source.deliverCallback' && object(payload)) {
    const { payloadDigest, ...content } = payload
    void payloadDigest
    return digest(content) as SeatDigest
  }
  return digest(payload) as SeatDigest
}

/** Validate the advertised frame bound and closed method set.
 * @param value - Optional peer capability.
 * @returns Validated capability, or absence for an old peer.
 */
export function decodeChainCapability(value: unknown): ChainCapability | undefined {
  if (value === undefined) return undefined
  if (!object(value) || value.capability !== 'node-work-chain/v1' || !Number.isSafeInteger(value.maxFrameBytes)
    || typeof value.maxFrameBytes !== 'number' || value.maxFrameBytes < 1 || value.maxFrameBytes > 1048576
    || !Array.isArray(value.methods) || value.methods.length === 0 || !value.methods.every(isChainMethod)
    || new Set(value.methods).size !== value.methods.length || !fields(value, ['capability', 'maxFrameBytes', 'methods'])) {
    throw new Error('Node chain capability rejected')
  }
  return { capability: 'node-work-chain/v1', maxFrameBytes: value.maxFrameBytes, methods: value.methods }
}

/** Decode complete frozen input before authority lookup; strings never grant permission.
 * @param value - Parsed wire or durable request.
 * @returns Validated chain frame.
 */
export function decodeChainRequest(value: unknown): ChainRequest {
  if (!object(value) || value.version !== NODE_LINK_VERSION || !identifier(value.requestId)
    || !identifier(value.sourceNodeId) || !identifier(value.targetNodeId) || value.sourceNodeId === value.targetNodeId
    || !identifier(value.operationId) || value.hop !== 1 || typeof value.deadline !== 'string'
    || !Number.isFinite(Date.parse(value.deadline)) || !isChainMethod(value.method)
    || value.payloadDigest !== chainDigest(value.method, value.payload)
    || !fields(value, ['version', 'requestId', 'sourceNodeId', 'targetNodeId', 'operationId', 'deadline', 'hop',
      'method', 'payload', 'payloadDigest', 'delegation'])) throw new Error('Node chain frame rejected')
  decodeNodeWorkChainRequest(value.method, value.payload)
  const delegation = value.delegation
  if (!object(delegation) || delegation.kind !== 'node-delegation' || delegation.hop !== 1
    || !identifier(delegation.principalId) || !identifier(delegation.authorizationRef)
    || delegation.sourceNodeId !== value.sourceNodeId || delegation.targetNodeId !== value.targetNodeId
    || delegation.operationId !== value.operationId || delegation.requestDigest !== value.payloadDigest
    || typeof delegation.expiresAt !== 'string' || !Number.isFinite(Date.parse(delegation.expiresAt))
    || !Array.isArray(delegation.taskIds) || !delegation.taskIds.every(identifier)
    || (delegation.seat !== undefined && !identifier(delegation.seat))
    || (delegation.sessionId !== undefined && !identifier(delegation.sessionId))
    || !fields(delegation, ['kind', 'hop', 'principalId', 'authorizationRef', 'sourceNodeId', 'targetNodeId',
      'operationId', 'requestDigest', 'expiresAt', 'taskIds', 'seat', 'sessionId'])) throw new Error('Node chain delegation rejected')
  const request = value as ChainRequest
  switch (request.method) {
    case 'seat.openFrozen': case 'seat.wakeFrozen':
      if (request.payload.request.operationId !== request.operationId) throw new Error('Node chain operation rejected')
      break
    case 'source.prepareOpening': case 'source.checkAdmission':
      if (request.payload.operationId !== request.operationId) throw new Error('Node chain operation rejected')
      break
    case 'source.deliverCallback':
      if (request.payload.payloadDigest !== request.payloadDigest) throw new Error('Node chain callback digest rejected')
      break
    case 'chain.operation':
      if (request.payload.key.method === 'chain.operation'
        || request.payload.key.principalId !== request.delegation.principalId
        || (request.payload.key.method === 'source.deliverCallback') !== (request.payload.key.callbackId !== undefined)) {
        throw new Error('Node chain query identity rejected')
      }
      break
    case 'engine.acceptFrozen':
      if (request.payload.route.originalOperationId !== request.operationId
        || request.payload.envelope.sourceId !== request.payload.route.sourceId
        || request.payload.envelope.triggerId !== request.payload.route.triggerId) throw new Error('Node chain trigger identity rejected')
      break
  }
  if (request.method === 'source.prepareOpening') {
    if (request.payload.sourceOwnerNodeId !== request.targetNodeId) throw new Error('Node chain owner rejected')
  } else if (request.method !== 'chain.operation') {
    const route = request.payload.route
    if (request.method === 'source.deliverCallback' || request.method === 'source.checkAdmission') {
      if (route.sourceOwnerNodeId !== request.targetNodeId || route.targetNodeId !== request.sourceNodeId) {
        throw new Error('Node chain callback route rejected')
      }
    } else if (route.targetNodeId !== request.targetNodeId) throw new Error('Node chain target rejected')
    if (request.method === 'source.deliverCallback' && (request.payload.callback.nodeId !== request.sourceNodeId
      || request.payload.callback.sourceId !== route.sourceId || request.payload.modelEvidence.nodeId !== request.sourceNodeId
      || request.payload.modelEvidence.sessionId !== request.payload.callback.sessionId)) throw new Error('Node chain model identity rejected')
    if (request.method === 'source.checkAdmission' && request.payload.executionNodeId !== request.sourceNodeId) {
      throw new Error('Node chain execution identity rejected')
    }
  }
  return request
}

/** Validate result and all correlated identities, including structured diagnostics.
 * @param value - Peer response or durable receipt.
 * @param request - Exact initiating request.
 * @returns Correlated response.
 */
export function decodeChainResponse(value: unknown, request: ChainRequest): ChainResponse {
  if (!object(value) || value.version !== NODE_LINK_VERSION || value.requestId !== request.requestId
    || value.operationId !== request.operationId || value.sourceNodeId !== request.sourceNodeId
    || value.targetNodeId !== request.targetNodeId || value.method !== request.method) throw new Error('Node chain response rejected')
  if (value.status === 'ok') decodeNodeWorkChainResult(request.method, value.result)
  else {
    const error = value.error
    if (!['unavailable', 'rejected', 'uncertain'].includes(String(value.status)) || !object(error)
      || typeof error.code !== 'string' || !Object.hasOwn(NODE_LINK_ERROR_CODES, error.code)
      || error.operationId !== request.operationId || error.targetNodeId !== request.targetNodeId
      || typeof error.retryable !== 'boolean' || !['none', 'unknown'].includes(String(error.effectState))) {
      throw new Error('Node chain failure rejected')
    }
    const cause = decodeSeatFailureCause(error.cause)
    if (cause.code !== error.code || cause.reason !== error.reason || cause.effectState !== error.effectState
      || cause.retryable !== error.retryable || cause.operationId !== request.operationId || cause.nodeId !== request.targetNodeId) {
      throw new Error('Node chain cause rejected')
    }
  }
  return value as ChainResponse
}

/** Decode a bounded exact evidence lookup without recursive delegation.
 * @param value - Parsed control frame.
 * @returns Validated control request.
 */
export function decodeEvidenceFrame(value: unknown): ChainEvidenceFrame {
  if (!object(value) || value.type !== 'delegation-evidence' || value.version !== NODE_LINK_VERSION
    || !identifier(value.requestId) || !fields(value, ['type', 'version', 'requestId', 'request'])) {
    throw new Error('Node evidence frame rejected')
  }
  return { type: 'delegation-evidence', version: NODE_LINK_VERSION,
    requestId: value.requestId as ChainEvidenceFrame['requestId'], request: decodeNodeDelegationEvidenceRequest(value.request) }
}

/** Correlate every retained evidence field before using the independent fact.
 * @param value - Authenticated peer reply.
 * @param frame - Original exact lookup.
 * @returns Correlated retained evidence or a safe refusal.
 */
export function decodeEvidenceResponse(value: unknown, frame: ChainEvidenceFrame): ChainEvidenceResponse {
  if (!object(value) || value.type !== frame.type || value.version !== NODE_LINK_VERSION
    || value.requestId !== frame.requestId || !fields(value, ['type', 'version', 'requestId', 'result'])) {
    throw new Error('Node evidence response rejected')
  }
  const result = decodeNodeDelegationEvidenceResult(value.result)
  if (result.status === 'retained' && digest(result.request) !== digest(frame.request)) throw new Error('Node evidence identity rejected')
  return { type: 'delegation-evidence', version: NODE_LINK_VERSION, requestId: frame.requestId, result }
}

/** Measure the complete JSON frame; carrier credentials remain HTTP headers.
 * @param frame - Complete transport frame including its delegation and JSON wrapper.
 * @param limits - Local and both negotiated complete-frame byte limits.
 * @returns Serialized frame; oversized frames throw before any send.
 */
export function encodeChainFrame(frame: unknown, limits: readonly number[]): string {
  return encodeNodeWorkChainFrame(frame, limits)
}
