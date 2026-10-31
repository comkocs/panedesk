/** Local administration consumes entry-owned grants and the engine's atomic approval capability. */
import type { HostAdminExecutionAdapter, HostAdminExecutionDependencies } from './execution.ts'
import { HOST_ADMIN_VERSION, type HostAdminExecutor, type HostAdminRequest, type HostAdminResponse } from './index.ts'
import { digest } from './json.ts'
import { queryAdmin } from './query.ts'

/** Construct an explicit adapter without installing services or starting another engine.
 * @param dependencies - Running engine and trusted local authorization capabilities.
 * @returns Fixed-method executor; approval never calls the legacy engine entry.
 */
export function createHostAdminExecutor(dependencies: HostAdminExecutionDependencies & {
  callbackResolver?: import('./index.ts').HostAdminCallbackResolver
}): HostAdminExecutor {
  const refuse = (request: HostAdminRequest): HostAdminResponse => ({ version: HOST_ADMIN_VERSION,
    requestId: request.requestId, method: request.method, status: 'rejected',
    code: 'admin-unauthorized', reason: 'Administration authority rejected' })
  const unavailable = (request: HostAdminRequest): HostAdminResponse => ({ version: HOST_ADMIN_VERSION,
    requestId: request.requestId, method: request.method, status: 'unavailable',
    code: 'admin-method-unavailable', reason: 'Source operator capability is unavailable' })
  return { execute: async (request, authority) => {
    const provider = dependencies.sourceOperator
    if (!authority.methods.includes(request.method)
      || ((request.method === 'engine.approve' || request.method === 'engine.cancel' || request.method === 'engine.callbackResolve'
        || request.method === 'source.abandon' || request.method === 'source.resend') && authority.kind !== 'local-operator')) return refuse(request)
    if ((request.method === 'source.operations' || request.method === 'source.abandon' || request.method === 'source.resend')
      && (!provider || request.method === 'source.resend' && !provider.resend)) return unavailable(request)
    const issuer = await dependencies.policy.authorize(request, authority)
    if ('status' in issuer) return refuse(request)
    const base = { version: HOST_ADMIN_VERSION, requestId: request.requestId, status: 'ok' as const }
    switch (request.method) {
      case 'source.operations':
        if (!provider) return unavailable(request)
        return { ...base, method: request.method, result: await provider.list(request.params) }
      case 'source.abandon':
      case 'source.resend': {
        const requestDigest = digest(request.params) as import('@panedesk/dsh-seat').SeatDigest
        const grant = await issuer.check({ operationId: request.params.operationId as import('@panedesk/dsh-seat').SeatOperationId,
          requestDigest })
        if ('status' in grant) return refuse(request)
        const { fact } = grant
        if (fact.decision !== 'allowed' || fact.kind !== 'local-operator'
          || fact.requestDigest !== requestDigest || fact.operationId !== request.params.operationId
          || fact.nodeId !== dependencies.nodeId || fact.principalId !== authority.principalId) return refuse(request)
        if (!provider) return unavailable(request)
        if (request.method === 'source.abandon') return { ...base, method: request.method,
          result: await provider.abandon(request.params, grant) }
        if (!provider.resend) return unavailable(request)
        return { ...base, method: request.method, result: await provider.resend(request.params, grant) }
      }
      case 'node.status': return { ...base, method: request.method, result: await dependencies.engine.nodeStatus() }
      case 'node.rebuild': return { ...base, method: request.method,
        result: await dependencies.rebuildTransport?.() ?? { status: 'unavailable' as const } }
      case 'engine.pending': return { ...base, method: request.method, result: await dependencies.engine.pending(request.params) }
      case 'engine.query':
        if (request.params.nodeId !== undefined && request.params.nodeId !== dependencies.nodeId) return refuse(request)
        return { ...base, method: request.method,
          result: await queryAdmin(dependencies.queries, dependencies.authorization, request.params) }
      case 'engine.operation':
        if (dependencies.authorization.operation) return { ...base, method: request.method,
          result: await dependencies.authorization.operation(request.params) }
        return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
          status: 'unavailable', code: 'admin-method-unavailable', reason: 'Local operation projection is unavailable' }
      case 'engine.callbackResolve': {
        if (!dependencies.callbackResolver) return unavailable(request)
        const requestDigest = digest(request.params) as import('@panedesk/dsh-seat').SeatDigest
        const operationId = `callback-resolve/${requestDigest}` as import('@panedesk/dsh-seat').SeatOperationId
        const grant = await issuer.check({ operationId, requestDigest })
        if ('status' in grant) return refuse(request)
        const fact = grant.fact
        if (fact.kind !== 'local-operator' || fact.decision !== 'allowed' || fact.nodeId !== dependencies.nodeId
          || fact.principalId !== authority.principalId || fact.operationId !== operationId
          || fact.requestDigest !== requestDigest) return refuse(request)
        return { ...base, method: request.method, result: await dependencies.callbackResolver.callbackResolve(request.params, grant) }
      }
      case 'engine.cancel':
      case 'engine.approve': {
        const grant = await issuer.check({ operationId: request.params.operationId,
          requestDigest: digest(request.params) as import('@panedesk/dsh-seat').SeatDigest })
        if ('status' in grant) return refuse(request)
        const fact = grant.fact
        if (fact.kind !== 'local-operator' || fact.nodeId !== dependencies.nodeId
          || fact.principalId !== authority.principalId || fact.operationId !== request.params.operationId
          || fact.requestDigest !== digest(request.params)) return refuse(request)
        if (request.method === 'engine.cancel') {
          if (!dependencies.authorization.cancel) return { ...base, method: request.method, status: 'unavailable',
            code: 'admin-method-unavailable', reason: 'Authorized cancellation is unavailable' }
          return { ...base, method: request.method, result: await dependencies.authorization.cancel(request.params, grant) }
        }
        return { ...base, method: request.method, result: await dependencies.authorization.approve(request.params, grant) }
      }
    }
  } }
}

/** Explicit factory value for hosts that compose the frozen adapter interface. */
export const hostAdminExecutionAdapter: HostAdminExecutionAdapter = { create: createHostAdminExecutor }
