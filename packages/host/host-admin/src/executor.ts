/** Local administration consumes entry-owned grants and the engine's atomic approval capability. */
import type { HostAdminExecutionAdapter, HostAdminExecutionDependencies } from './execution.ts'
import { HOST_ADMIN_VERSION, type HostAdminExecutor, type HostAdminRequest, type HostAdminResponse } from './index.ts'
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
    if (!authority.methods.includes(request.method)) return refuse(request)
    const base = { version: HOST_ADMIN_VERSION, requestId: request.requestId, status: 'ok' as const }
    switch (request.method) {
      case 'source.operations':
        if (!provider) return unavailable(request)
        return { ...base, method: request.method, result: await provider.list(request.params) }
      case 'source.abandon':
      case 'source.resend': {
        if (!provider) return unavailable(request)
        if (request.method === 'source.abandon') return { ...base, method: request.method,
          result: await provider.abandon(request.params) }
        if (!provider.resend) return unavailable(request)
        return { ...base, method: request.method, result: await provider.resend(request.params) }
      }
      case 'node.status': return { ...base, method: request.method, result: await dependencies.engine.nodeStatus() }
      case 'node.rebuild': return { ...base, method: request.method,
        result: await dependencies.rebuildTransport?.(request.params.peerNodeId) ?? { status: 'unavailable' as const } }
      case 'engine.pending': return { ...base, method: request.method, result: await dependencies.engine.pending(request.params) }
      case 'engine.query':
        if (request.params.nodeId !== undefined && request.params.nodeId !== dependencies.nodeId) return refuse(request)
        if (!dependencies.queries || !dependencies.authorization) return unavailable(request)
        return { ...base, method: request.method,
          result: await queryAdmin(dependencies.queries, dependencies.authorization, request.params) }
      case 'engine.operation':
        if (dependencies.authorization?.operation) return { ...base, method: request.method,
          result: await dependencies.authorization.operation(request.params) }
        return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
          status: 'unavailable', code: 'admin-method-unavailable', reason: 'Local operation projection is unavailable' }
      case 'engine.callbackResolve': {
        if (!dependencies.callbackResolver) return unavailable(request)
        return { ...base, method: request.method, result: await dependencies.callbackResolver.callbackResolve(request.params) }
      }
      case 'engine.cancel':
        return { ...base, method: request.method, result: await dependencies.engine.cancel(request.params) }
      case 'engine.approve':
        return { ...base, method: request.method, result: await dependencies.engine.approve(request.params) }
    }
  } }
}

/** Explicit factory value for hosts that compose the frozen adapter interface. */
export const hostAdminExecutionAdapter: HostAdminExecutionAdapter = { create: createHostAdminExecutor }
