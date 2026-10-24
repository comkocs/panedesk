/** Local administration consumes entry-owned grants and the engine's atomic approval capability. */
import type { HostAdminExecutionAdapter, HostAdminExecutionDependencies } from './execution.ts'
import { HOST_ADMIN_VERSION, type HostAdminExecutor, type HostAdminRequest, type HostAdminResponse } from './index.ts'
import { digest } from './json.ts'
import { queryAdmin } from './query.ts'

/** Construct an explicit adapter without installing services or starting another engine.
 * @param dependencies - Running engine and trusted local authorization capabilities.
 * @returns Fixed-method executor; approval never calls the legacy engine entry.
 */
export function createHostAdminExecutor(dependencies: HostAdminExecutionDependencies): HostAdminExecutor {
  const refuse = (request: HostAdminRequest): HostAdminResponse => ({ version: HOST_ADMIN_VERSION,
    requestId: request.requestId, method: request.method, status: 'rejected',
    code: 'admin-unauthorized', reason: 'Administration authority rejected' })
  return { execute: async (request, authority) => {
    if (!authority.methods.includes(request.method)
      || (request.method === 'engine.approve' && authority.kind !== 'local-operator')) return refuse(request)
    const issuer = await dependencies.policy.authorize(request, authority)
    if ('status' in issuer) return refuse(request)
    const base = { version: HOST_ADMIN_VERSION, requestId: request.requestId, status: 'ok' as const }
    switch (request.method) {
      case 'node.status': return { ...base, method: request.method, result: await dependencies.engine.nodeStatus() }
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
      case 'engine.approve': {
        const grant = await issuer.check({ operationId: request.params.operationId,
          requestDigest: digest(request.params) as import('@panedesk/dsh-seat').SeatDigest })
        if ('status' in grant) return refuse(request)
        const fact = grant.fact
        if (fact.kind !== 'local-operator' || fact.nodeId !== dependencies.nodeId
          || fact.principalId !== authority.principalId || fact.operationId !== request.params.operationId
          || fact.requestDigest !== digest(request.params)) return refuse(request)
        return { ...base, method: request.method, result: await dependencies.authorization.approve(request.params, grant) }
      }
    }
  } }
}

/** Explicit factory value for hosts that compose the frozen adapter interface. */
export const hostAdminExecutionAdapter: HostAdminExecutionAdapter = { create: createHostAdminExecutor }
