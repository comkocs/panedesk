/** Optional administration owns credentials, epoch, listener and durable replay until disposal. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { HOST_ADMIN_METHODS, HOST_ADMIN_VERSION, hostAdminDetailCode } from './index.ts'
import type { Config, HostAdminAuthority, HostAdminEndpoint, HostAdminRequest, HostAdminResponse, HostAdminService } from './index.ts'
import { LocalPrivateFiles, PosixPrivateFiles } from './private-files.ts'
import { isPrivateFilesContextActive } from './private-files-ready.ts'
import { OperationStore } from './operation-store.ts'
import { listenAuthenticatedLoopback, type LoopbackListener } from './loopback.ts'
import { SessionCredentials } from './session-credentials.ts'
import { decodeSdkRequest, type HostSdkResponse } from './sdk-codec.ts'
import type { HostSdkIdentity } from './sdk.ts'
import { object } from './json.ts'
import { decodeRequest, decodeResponse } from './codec.ts'
import { digest } from './json.ts'
import { executeLocal } from './local-executor.ts'
import { drainRuntime, onRuntimeTermination } from './runtime-cleanup.ts'

/** Install only under explicit runtime configuration.
 * @param ctx - Lifecycle and optional local executor.
 * @param config - Explicit listener and durable store bounds.
 * @returns Disposer that drains accepted calls and releases owned resources.
 */
export async function mountAdmin(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const options = config.runtime
  if (options === undefined) return () => Promise.resolve()
  const windows = process.platform === 'win32'
  const inactive = () => windows && !isPrivateFilesContextActive(ctx)
  if (inactive()) return async () => {}
  const privateFiles = (directory: string) => ctx.get('hostAdminFiles')?.(directory)
    ?? (windows ? new LocalPrivateFiles(directory) : new PosixPrivateFiles(directory, process.getuid?.() ?? -1))
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
    ...(request.method === 'source.abandon' || request.method === 'source.resend'
      ? { operationId: request.params.operationId as import('@panedesk/dsh-seat').SeatOperationId } : {}),
  })
  const service: HostAdminService = { dispatch: async (request, authenticatedAuthority) => {
    if (stopped) return failure(request, 'admin-unavailable')
    if (!authenticatedAuthority.methods.includes(request.method)) return failure(request, 'admin-unauthorized')
    const execute = async (): Promise<HostAdminResponse> => {
      if (request.method === 'source.operations' || request.method === 'source.abandon' || request.method === 'source.resend') {
        const provider = ctx.get('hostAdminSourceOperator')
        if (!provider || request.method === 'source.resend' && !provider.resend) return {
          version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
          status: 'unavailable', code: 'admin-method-unavailable', reason: 'Source operator capability is unavailable' }
        if (request.method === 'source.operations') {
          try {
            return decodeResponse({ version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
              status: 'ok', result: await provider.list(request.params) }, request)
          } catch (error) {
            const detail = hostAdminDetailCode(error)
            if (detail === undefined) throw error
            return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
              status: 'unavailable' as const, code: 'admin-unavailable' as const, detail, reason: detail }
          }
        }
      }
      const executor = ctx.get('hostAdminExecutor')
      if (executor !== undefined) return decodeResponse(await executor.execute(request, authenticatedAuthority), request)
      const engine = ctx.get('seatEngine')
      if (request.method === 'node.status' && engine !== undefined) return { version: HOST_ADMIN_VERSION,
        requestId: request.requestId, method: request.method, status: 'ok', result: await engine.nodeStatus() }
      if (request.method === 'node.rebuild') {
        const control = ctx.get('hostAdminTransport')
        return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method, status: 'ok',
          result: control ? await control.rebuildTransport(request.params.peerNodeId) : { status: 'unavailable' as const } }
      }
      if (request.method === 'engine.pending' && engine !== undefined) return { version: HOST_ADMIN_VERSION,
        requestId: request.requestId, method: request.method, status: 'ok', result: await engine.pending(request.params) }
      const response = await executeLocal(ctx, request, authority, options.nodeId as HostAdminEndpoint['nodeId'],
        options.maxOperations, () => !stopped)
      if (response) return decodeResponse(response, request)
      if (request.method === 'source.abandon' || request.method === 'source.resend') return {
        version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
        status: 'unavailable', code: 'admin-method-unavailable', reason: 'Source operator capability is unavailable' }
      return failure(request, 'admin-method-unavailable')
    }
    if (request.method === 'engine.callbackResolve') {
      try { return await execute() }
      catch (error) { void error; return failure(request, 'admin-outcome-unknown') }
    }
    if (request.method !== 'engine.approve' && request.method !== 'engine.cancel'
      && request.method !== 'source.abandon' && request.method !== 'source.resend') return execute()
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
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    stopped = true
    sdkAbort.abort()
    removeSignals()
    closing ??= drainRuntime([
      () => sessions.close(),
      () => ready.catch((error: unknown) => { void error }),
      () => listener?.close(),
      () => store.close(),
      () => unlock === undefined ? undefined : files.remove('credential'),
      () => unlock === undefined ? undefined : files.remove('endpoint.json'),
      () => unlock?.(),
    ])
    return closing
  }
  const removeSignals = onRuntimeTermination(dispose, () => { ctx.logger.error('host-admin-shutdown-failed: runtime cleanup failed') })
  try { await ready }
  catch (error) { await dispose(); throw error }
  return dispose
}
