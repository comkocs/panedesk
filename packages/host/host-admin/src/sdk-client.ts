/** File-authenticated SDK calls never spawn a process or retry an uncertain write. */
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute } from 'node:path'
import { PosixPrivateFiles, type PrivateFiles } from './private-files.ts'
import { callLoopback, type RpcLimits } from './loopback.ts'
import { HOST_ADMIN_VERSION } from './index.ts'
import { identifier, object, parseJson } from './json.ts'
import { decodeSdkRequest, decodeSdkResponse } from './sdk-codec.ts'
import type { HostSdkResult } from './sdk.ts'

/** Operator-only administration client; session SDK credentials never grant source writes. */
export { callAdmin as callHostAdmin } from './client.ts'

/** Explicit file paths, never credential values or arbitrary endpoint URLs. */
export interface RunningHostOptions extends RpcLimits {
  endpointPath: string
  credentialPath: string
  /** Required on platforms without POSIX ownership checks; absent uses checked POSIX files. */
  privateFiles?: (directory: string) => PrivateFiles
}
/** Call one registered namespace on an existing host.
 * @param options - Private file paths and complete-frame/deadline bounds.
 * @param method - Registered namespace/method name.
 * @param params - Untrusted namespace parameters; never a source of caller authority.
 * @returns Correlated namespace result; transport errors do not expose private bytes.
 */
export async function callHostSdk(options: RunningHostOptions, method: string, params: unknown): Promise<HostSdkResult> {
  const parts = method.split('/')
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z][A-Za-z0-9._-]*$/.test(part))) {
    return { status: 'rejected', code: 'method-unavailable' }
  }
  if (!isAbsolute(options.endpointPath) || !isAbsolute(options.credentialPath)) throw new Error('Private paths must be absolute')
  const files = (path: string) => options.privateFiles?.(dirname(path))
    ?? new PosixPrivateFiles(dirname(path), process.getuid?.() ?? -1)
  const text = await files(options.endpointPath).read(basename(options.endpointPath), options.maxFrameBytes)
  const credential = await files(options.credentialPath).read(basename(options.credentialPath), 64)
  if (text === null || credential === null || !/^[a-f0-9]{64}$/.test(credential)) throw new Error('Host credentials unavailable')
  const endpoint = parseJson(text, options.maxFrameBytes)
  if (!object(endpoint) || endpoint.version !== HOST_ADMIN_VERSION || !identifier(endpoint.processEpoch)
    || !identifier(endpoint.nodeId) || !Number.isSafeInteger(endpoint.pid) || Number(endpoint.pid) < 1
    || !Number.isInteger(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535
    || endpoint.credentialRef !== 'credential') throw new Error('Host endpoint rejected')
  const request = decodeSdkRequest({ version: HOST_ADMIN_VERSION, processEpoch: endpoint.processEpoch,
    requestId: randomUUID(), nonce: randomUUID(), method: 'sdk.invoke',
    params: { namespace: parts[0], method: parts[1], params } })
  const response = await callLoopback(Number(endpoint.port), { credential, epoch: endpoint.processEpoch }, request, options)
  return decodeSdkResponse(response, request)
}
