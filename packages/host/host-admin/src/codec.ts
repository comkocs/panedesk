/** Administrative frames validate identity separately from provider-owned operation semantics. */
import { decodeSeatRequest, decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import { HOST_ADMIN_METHODS, HOST_ADMIN_VERSION, HOST_ADMIN_ERROR_CODES } from './index.ts'
import type { HostAdminRequest, HostAdminResponse } from './index.ts'
import { object, identifier } from './json.ts'

/** Decode only the frozen administrative method set.
 * @param value - Bounded JSON request.
 * @returns Validated frame; unknown fields cannot self-assign authority.
 */
export function decodeRequest(value: unknown): HostAdminRequest {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || !identifier(value.requestId)
    || !identifier(value.processEpoch) || !identifier(value.nonce) || typeof value.method !== 'string'
    || !HOST_ADMIN_METHODS.some(method => method === value.method)
    || Object.keys(value).some(key => !['version', 'requestId', 'processEpoch', 'nonce', 'method', 'params'].includes(key))) {
    throw new Error('Administration frame rejected')
  }
  switch (value.method) {
    case 'node.status': decodeSeatRequest('seats/nodeStatus', value.params); break
    case 'engine.pending': decodeSeatRequest('seats/pending', value.params); break
    case 'engine.approve': decodeSeatRequest('seats/approve', value.params); break
    case 'engine.operation': decodeSeatRequest('seats/operation', value.params); break
    case 'engine.query': {
      const params = value.params
      if (!object(params) || !Number.isSafeInteger(params.limit) || Number(params.limit) < 1
        || Object.keys(params).some(key => !['limit', 'cursor', 'nodeId', 'seat', 'kinds', 'from', 'to', 'taskId'].includes(key))
        || Object.entries(params).some(([key, entry]) => !['limit', 'cursor', 'kinds'].includes(key) && !identifier(entry))
        || (params.kinds !== undefined && (!Array.isArray(params.kinds) || !params.kinds.every(identifier)))) {
        throw new Error('Administration query rejected')
      }
      if (params.cursor !== undefined && (!object(params.cursor) || !identifier(params.cursor.nodeId)
        || !Number.isSafeInteger(params.cursor.sequence) || Number(params.cursor.sequence) < 0
        || !Number.isSafeInteger(params.cursor.effectIndex) || Number(params.cursor.effectIndex) < 0)) {
        throw new Error('Administration cursor rejected')
      }
      break
    }
  }
  return value as HostAdminRequest
}

/** Validate response correlation and provider result discrimination.
 * @param value - Bounded response or durable replay.
 * @param request - Original validated request.
 * @returns Correlated response; malformed replies remain unknown outcomes.
 */
export function decodeResponse(value: unknown, request: HostAdminRequest): HostAdminResponse {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || value.requestId !== request.requestId || value.method !== request.method) {
    throw new Error('Administration response identity rejected')
  }
  if (value.status !== 'ok') {
    if (!['rejected', 'unavailable', 'uncertain'].includes(String(value.status))
      || !HOST_ADMIN_ERROR_CODES.some(code => code === value.code) || typeof value.reason !== 'string') {
      throw new Error('Administration failure rejected')
    }
    return value as HostAdminResponse
  }
  switch (request.method) {
    case 'node.status': decodeSeatResult('seats/nodeStatus', value.result); break
    case 'engine.pending':
      if (object(value.result) && value.result.status === 'rejected') decodeSeatResult('seats/approve', value.result)
      else decodeSeatResult('seats/pending', value.result)
      break
    case 'engine.approve': decodeSeatResult('seats/approve', value.result); break
    case 'engine.operation': decodeSeatResult('seats/operation', value.result); break
    case 'engine.query':
      if (object(value.result) && value.result.status === 'rejected') {
        decodeSeatResult('seats/approve', value.result)
        break
      }
      if (!object(value.result) || !Array.isArray(value.result.effects) || typeof value.result.complete !== 'boolean'
        || !Number.isSafeInteger(value.result.watermark)) throw new Error('Administration query result rejected')
      break
  }
  return value as HostAdminResponse
}
