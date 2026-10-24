/** Optional administration owns credentials, epoch, listener and durable replay until disposal. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { HOST_ADMIN_METHODS, HOST_ADMIN_VERSION } from './index.ts'
import type { Config, HostAdminAuthority, HostAdminEndpoint, HostAdminRequest, HostAdminResponse, HostAdminService } from './index.ts'
import { PosixPrivateFiles } from './private-files.ts'
import { OperationStore } from './operation-store.ts'
import { listenLoopback, type LoopbackListener } from './loopback.ts'
import { decodeRequest, decodeResponse } from './codec.ts'
import { digest } from './json.ts'

/** Install only under explicit runtime configuration.
 * @param ctx - Lifecycle and optional local executor.
 * @param config - Explicit listener and durable store bounds.
 * @returns Disposer that drains accepted calls and releases owned resources.
 */
export async function mountAdmin(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const options = config.runtime
  if (options === undefined) return () => Promise.resolve()
  const files = ctx.get('hostAdminFiles')?.(options.directory)
    ?? new PosixPrivateFiles(options.directory, process.getuid?.() ?? -1)
  const epoch = randomUUID() as HostAdminEndpoint['processEpoch']
  const credential = randomBytes(32).toString('hex')
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
    ...(request.method === 'engine.approve' ? { operationId: request.params.operationId } : {}),
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
      if (request.method === 'engine.approve' && engine && authenticatedAuthority === authority) {
        const issuers = ctx.get('seatAuthorizationIssuers'), transactions = ctx.get('seatAuthorizationTransactions')
        if (!issuers || !transactions) return failure(request, 'admin-method-unavailable')
        let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
        let pending: import('@panedesk/dsh-seat').PendingSeatItem | undefined
        do {
          const page = await engine.pending({ limit: options.maxOperations, ...(cursor ? { cursor } : {}) })
          pending = page.items.find(item => item.queueItemId === request.params.queueItemId)
          if (pending || page.complete) break
          if (!page.nextCursor) return failure(request, 'admin-unavailable')
          cursor = page.nextCursor
        } while (!stopped)
        if (!pending) return failure(request, 'admin-unauthorized')
        const registration = issuers.register({ identity: { kind: 'local-operator', principalId: authority.principalId,
          origin: 'manual', nodeId: options.nodeId as HostAdminEndpoint['nodeId'], seat: pending.seat,
          taskIds: pending.relatedTaskIds, policyRevision: 0 },
        current: () => stopped ? null : { decision: 'allowed', reasonCode: 'authenticated-local-operator', policyRevision: 0 } })
        try {
          const grant = await registration.issuer.check({ operationId: request.params.operationId,
            requestDigest: digest(request.params) as import('@panedesk/dsh-seat').SeatDigest })
          if ('status' in grant) return failure(request, 'admin-unauthorized')
          return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method, status: 'ok',
            result: await transactions.approve(request.params, grant) }
        } finally { registration.dispose() }
      }
      return failure(request, 'admin-method-unavailable')
    }
    if (request.method !== 'engine.approve') return execute()
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
    listener = await listenLoopback(options.port, options, () => ({ credential, epoch }), async (value) => {
      const request = decodeRequest(value)
      if (nonces.has(request.nonce) || nonces.size >= options.maxOperations) return failure(request, 'admin-unauthorized')
      nonces.add(request.nonce)
      return service.dispatch(request, authority)
    })
    const endpoint: HostAdminEndpoint & { port: number } = { version: HOST_ADMIN_VERSION,
      nodeId: options.nodeId as HostAdminEndpoint['nodeId'], pid: process.pid, processEpoch: epoch,
      credentialRef: 'credential' as HostAdminEndpoint['credentialRef'], port: listener.port }
    await files.write('endpoint.json', JSON.stringify(endpoint))
  })()
  const dispose = async (): Promise<void> => {
    stopped = true
    await ready.catch((error: unknown) => { void error })
    await listener?.close()
    await store.close()
    if (unlock !== undefined) {
      await files.remove('credential')
      await files.remove('endpoint.json')
      await unlock()
    }
  }
  try { await ready }
  catch (error) { await dispose(); throw error }
  return dispose
}
