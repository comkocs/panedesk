/** Additive SDK envelopes leave the five administrative request types unchanged. */
import { HOST_ADMIN_VERSION, type HostAdminEndpoint } from './index.ts'
import { identifier, object } from './json.ts'
import type { HostSdkInvocation, HostSdkResult } from './sdk.ts'

/** Correlation and replay fields are shared with administration, not caller identity. */
export interface HostSdkRequest {
  version: typeof HOST_ADMIN_VERSION
  requestId: string
  processEpoch: HostAdminEndpoint['processEpoch']
  nonce: string
  method: 'sdk.invoke'
  params: HostSdkInvocation
}
/** Namespace failures remain distinct from transport failure and successful JSON. */
export interface HostSdkResponse {
  version: typeof HOST_ADMIN_VERSION
  requestId: string
  method: 'sdk.invoke'
  result: HostSdkResult
}
/** Decode the one additive SDK method without accepting caller-owned authority.
 * @param value - Bounded untrusted JSON.
 * @returns Validated SDK envelope.
 */
export function decodeSdkRequest(value: unknown): HostSdkRequest {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || value.method !== 'sdk.invoke'
    || !identifier(value.requestId) || !identifier(value.processEpoch) || !identifier(value.nonce)
    || Object.keys(value).some(key => !['version', 'requestId', 'processEpoch', 'nonce', 'method', 'params'].includes(key))
    || !object(value.params) || typeof value.params.namespace !== 'string' || typeof value.params.method !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(value.params.namespace)
    || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(value.params.method)
    || Object.keys(value.params).some(key => !['namespace', 'method', 'params'].includes(key))) {
    throw new Error('SDK invocation rejected')
  }
  return { version: HOST_ADMIN_VERSION, requestId: value.requestId,
    processEpoch: value.processEpoch as HostAdminEndpoint['processEpoch'], nonce: value.nonce,
    method: 'sdk.invoke', params: { namespace: value.params.namespace, method: value.params.method, params: value.params.params } }
}
/** Validate correlation and the safe result discriminator.
 * @param value - Bounded JSON response.
 * @param request - Original request.
 * @returns Correlated result; malformed replies reject without exposing payloads.
 */
export function decodeSdkResponse(value: unknown, request: HostSdkRequest): HostSdkResult {
  if (!object(value) || value.version !== HOST_ADMIN_VERSION || value.method !== 'sdk.invoke'
    || value.requestId !== request.requestId || !object(value.result)) throw new Error('SDK response rejected')
  const result = value.result
  if (result.status === 'ok' && Object.hasOwn(result, 'value')) return result as HostSdkResult
  if (result.status === 'rejected' && ['method-unavailable', 'unauthorized', 'invalid-params', 'unavailable'].includes(String(result.code))) {
    return result as HostSdkResult
  }
  throw new Error('SDK response rejected')
}
