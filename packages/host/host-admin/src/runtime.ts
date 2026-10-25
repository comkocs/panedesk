/** Optional administration owns credentials, epoch, listener and durable replay until disposal. */
import { randomBytes, randomUUID } from 'node:crypto'
import { FiberState, type Context } from '@panedesk/cordis'
import { HOST_ADMIN_METHODS, HOST_ADMIN_VERSION } from './index.ts'
import type { Config, HostAdminAuthority, HostAdminEndpoint, HostAdminRequest, HostAdminResponse, HostAdminService } from './index.ts'
import { PosixPrivateFiles } from './private-files.ts'
import { waitForPrivateFiles, PrivateFilesWaitCancelled } from './private-files-ready.ts'
import { OperationStore } from './operation-store.ts'
import { listenAuthenticatedLoopback, type LoopbackListener } from './loopback.ts'
import { SessionCredentials } from './session-credentials.ts'
import { decodeSdkRequest, type HostSdkResponse } from './sdk-codec.ts'
import type { HostSdkIdentity } from './sdk.ts'
import { object } from './json.ts'
import { decodeRequest, decodeResponse } from './codec.ts'
import { digest } from './json.ts'
import { executeLocal } from './local-executor.ts'

/** Install only under explicit runtime configuration.
 * @param ctx - Lifecycle and optional local executor.
 * @param config - Explicit listener and durable store bounds.
 * @returns Disposer that drains accepted calls and releases owned resources.
 */
export async function mountAdmin(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const options = config.runtime
  if (options === undefined) return () => Promise.resolve()
  const windows = process.platform === 'win32'
  const inactive = () => windows && (ctx.fiber.uid === null || ctx.fiber.state === FiberState.UNLOADING)
  const windowsFactory = windows
    ? await waitForPrivateFiles(ctx, 'hostAdminFiles', options.requestTimeoutMs, () => ctx.get('hostAdminFiles')).catch((error: unknown) => {
      if (error instanceof PrivateFilesWaitCancelled) return undefined
      throw error
    }) : undefined
  if (inactive()) return async () => {}
  const privateFiles = windowsFactory ?? ((directory: string) => ctx.get('hostAdminFiles')?.(directory)
    ?? new PosixPrivateFiles(directory, process.getuid?.() ?? -1))
  const files = privateFiles(options.directory)
  const epoch = randomUUID() as HostAdminEndpoint['processEpoch']
  const credential = randomBytes(32).toString('hex')
  const sdkAbort = new AbortController()
  const operatorIdentity: HostSdkIdentity = Object.freeze({ principalId: options.principalId as HostSdkIdentity['principalId'],
    authorizationRef: `admin:${epoch}` as HostSdkIdentity['authorizationRef'], signal: sdkAbort.signal })
  const sessions = new SessionCredentials(options.directory, epoch, privateFiles)
  const store = new OperationStore(files, options.maxStoreBytes, options.maxOperations)
  const authority: HostAdminAuthority = { principalId: options.principalId as HostAdminAuthority['principalId'],
    authorizationRef: `admin:${epoch}` as HostAdminAuthority['authorizationRef'], kind: 'local-operator', methods: HOST_ADMIN_METHODS }
  let unlock: (() => Promise<void>) | undefined
  let listener: LoopbackListener | undefined
  let stopped = false
  const nonces = new Set<string>()
  const failure = (request: HostAdminRequest, code: Exclude<HostAdminResponse, { status: 'ok' }>['code']): HostAdminResponse => ({
    version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
    status: code === 'admin-outcome-unknown' ? 'uncertain' : 'rejected', code, reason: code,
    ...(request.method === 'engine.approve' || request.method === 'engine.cancel' ? { operationId: request.params.operationId } : {}),
  })
  const service: HostAdminService = { dispatch: async (request, authenticatedAuthority) => {
    if (stopped) return failure(request, 'admin-unavailable')
    if (request.processEpoch !== epoch) return failure(request, 'admin-stale-epoch')
    if (!authenticatedAuthority.methods.includes(request.method)) return failure(request, 'admin-unauthorized')
    const execute = async (): Promise<HostAdminResponse> => {
      const executor = ctx.get('hostAdminExecutor')
      if (executor !== undefined) return decodeResponse(await executor.execute(request, authenticatedAuthority), request)
      const engine = ctx.get('seatEngine')
      if (request.method === 'node.status' && engine !== undefined) return { version: HOST_ADMIN_VERSION,
        requestId: request.requestId, method: request.method, status: 'ok', result: await engine.nodeStatus() }
      if (request.method === 'engine.pending' && engine !== undefined) return { version: HOST_ADMIN_VERSION,
        requestId: request.requestId, method: request.method, status: 'ok', result: await engine.pending(request.params) }
      if (authenticatedAuthority !== authority) return failure(request, 'admin-unauthorized')
      const response = await executeLocal(ctx, request, authority, options.nodeId as HostAdminEndpoint['nodeId'],
        options.maxOperations, () => !stopped)
      if (response) return decodeResponse(response, request)
      return failure(request, 'admin-method-unavailable')
    }
    if (request.method !== 'engine.approve' && request.method !== 'engine.cancel') return execute()
    if (authenticatedAuthority.kind !== 'local-operator'
      || !ctx.get('hostAdminExecutor') && authenticatedAuthority !== authority) return failure(request, 'admin-unauthorized')
    try {
      const outcome = await store.run(`${authenticatedAuthority.principalId}:${request.params.operationId}`,
        digest({ method: request.method, params: request.params, principalId: authenticatedAuthority.principalId }), execute)
      if (outcome.state === 'conflict') return failure(request, 'admin-unauthorized')
      if (outcome.state !== 'settled') return failure(request, 'admin-outcome-unknown')
      const replay = outcome.result
      if (typeof replay !== 'object' || replay === null) return failure(request, 'admin-outcome-unknown')
      return decodeResponse({ ...replay, requestId: request.requestId }, request)
    } catch (error) { void error; return failure(request, 'admin-outcome-unknown') }
  } }
  ctx.provide('hostAdmin', service)
  const ready = (async () => {
    await files.prepare()
    unlock = await files.lock()
    await store.load()
    await files.write('credential', credential)
    listener = await listenAuthenticatedLoopback(options.port, options,
      () => ({ credential, epoch, identity: operatorIdentity, alternatives: sessions.authentication() }),
      async (value, _epoch, identity) => {
        if (object(value) && value.method === 'sdk.invoke') {
          const request = decodeSdkRequest(value)
          const response = (result: HostSdkResponse['result']): HostSdkResponse => ({ version: HOST_ADMIN_VERSION,
            requestId: request.requestId, method: 'sdk.invoke', result })
          const caller = identity === operatorIdentity ? operatorIdentity : sessions.identity(identity)
          if (stopped || request.processEpoch !== epoch || caller === undefined || caller.signal.aborted
            || nonces.has(request.nonce) || nonces.size >= options.maxOperations) {
            return response({ status: 'rejected', code: 'unauthorized' })
          }
          nonces.add(request.nonce)
          const invoker = ctx.get('hostSdkInvoker')
          if (invoker === undefined) return response({ status: 'rejected', code: 'method-unavailable' })
          return response(await invoker.invoke(request.params, caller))
        }
        const request = decodeRequest(value)
        if (identity !== operatorIdentity) return failure(request, 'admin-unauthorized')
        if (nonces.has(request.nonce) || nonces.size >= options.maxOperations) return failure(request, 'admin-unauthorized')
        nonces.add(request.nonce)
        return service.dispatch(request, authority)
      })
    const endpoint: HostAdminEndpoint & { port: number } = { version: HOST_ADMIN_VERSION,
      nodeId: options.nodeId as HostAdminEndpoint['nodeId'], pid: process.pid, processEpoch: epoch,
      credentialRef: 'credential' as HostAdminEndpoint['credentialRef'], port: listener.port }
    await files.write('endpoint.json', JSON.stringify(endpoint))
    if (inactive()) return
    ctx.provide('hostSessionCredentials', sessions)
  })()
  const dispose = async (): Promise<void> => {
    stopped = true
    sdkAbort.abort()
    try { await sessions.close() }
    finally {
      await ready.catch((error: unknown) => { void error })
      await listener?.close()
      await store.close()
      if (unlock !== undefined) {
        await files.remove('credential')
        await files.remove('endpoint.json')
        await unlock()
      }
    }
  }
  try { await ready }
  catch (error) { await dispose(); throw error }
  return dispose
}
