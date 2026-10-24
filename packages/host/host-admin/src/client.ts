/** Thin administration client never starts a host or reads browser credentials. */
import { randomUUID } from 'node:crypto'
import type { PrivateFiles } from './private-files.ts'
import { callLoopback, type RpcLimits } from './loopback.ts'
import { decodeRequest, decodeResponse } from './codec.ts'
import { HOST_ADMIN_VERSION, type HostAdminRequest, type HostAdminResponse } from './index.ts'
import { identifier, object, parseJson } from './json.ts'

/** Read an owned endpoint and credential, then make one authenticated call.
 * @param files - Checked private directory or Windows ACL provider.
 * @param method - Frozen administrative method.
 * @param params - Provider request, validated before transmission.
 * @param limits - Explicit bounded transport options.
 * @returns Provider evidence or an explicit unknown approval outcome.
 */
export async function callAdmin(files: PrivateFiles, method: HostAdminRequest['method'], params: unknown,
  limits: RpcLimits): Promise<HostAdminResponse> {
  const text = await files.read('endpoint.json', limits.maxFrameBytes)
  const credential = await files.read('credential', 64)
  if (text === null || credential === null) throw new Error('Administration endpoint unavailable')
  const endpoint = parseJson(text, limits.maxFrameBytes)
  if (!object(endpoint) || endpoint.version !== HOST_ADMIN_VERSION || !identifier(endpoint.processEpoch)
    || !Number.isInteger(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535
    || endpoint.credentialRef !== 'credential' || !identifier(endpoint.nodeId)
    || !Number.isSafeInteger(endpoint.pid) || Number(endpoint.pid) < 1) throw new Error('Administration endpoint rejected')
  const request = decodeRequest({ version: HOST_ADMIN_VERSION, processEpoch: endpoint.processEpoch,
    requestId: randomUUID(), nonce: randomUUID(), method, params })
  try {
    return decodeResponse(await callLoopback(Number(endpoint.port), { credential, epoch: endpoint.processEpoch }, request, limits), request)
  }
  catch (error) {
    void error
    return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
      status: method === 'engine.approve' ? 'uncertain' : 'unavailable',
      code: method === 'engine.approve' ? 'admin-outcome-unknown' : 'admin-unavailable', reason: 'Administration response unavailable',
      ...(request.method === 'engine.approve' ? { operationId: request.params.operationId } : {}),
    }
  }
}
