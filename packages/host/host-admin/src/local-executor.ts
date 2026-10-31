/** Running-host assembly scopes entry-issued authority to one authenticated invocation. */
import type { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-seat-engine'
import { createHostAdminExecutor } from './executor.ts'
import type { HostAdminAuthority, HostAdminEndpoint, HostAdminRequest, HostAdminResponse } from './index.ts'

/** Assemble the real transaction adapter without installing or starting another engine.
 * @param ctx - Running provider context.
 * @param request - Authenticated and validated request.
 * @param authority - Exact transport-owned operator identity.
 * @param nodeId - Configured local node.
 * @param limit - Pending scan page bound.
 * @param current - Whether this administration lifecycle still owns its credential.
 * @returns Provider response, or null when required capabilities are absent.
 */
export async function executeLocal(ctx: Context, request: HostAdminRequest, authority: HostAdminAuthority,
  nodeId: HostAdminEndpoint['nodeId'], limit: number, current: () => boolean): Promise<HostAdminResponse | null> {
  const engine = ctx.get('seatEngine'), authorization = ctx.get('seatAuthorizationTransactions')
  const issuers = ctx.get('seatAuthorizationIssuers'), queries = ctx.get('seatAuthorizationQueries')
  if (!engine || !authorization || !issuers || !queries) return null
  let registration: ReturnType<Seat.SeatAuthorizationIssuers['register']> | undefined
  const sourceOperator = ctx.get('hostAdminSourceOperator')
  const callbackResolver = engine.callbackResolve ? {
    callbackResolve: (params: import('./index.ts').HostAdminCallbackResolveRequest, grant: Seat.SeatAuthorizationGrant) =>
      (engine.callbackResolve as NonNullable<typeof engine.callbackResolve>)(params, grant),
  } : undefined
  const transport = ctx.get('hostAdminTransport')
  const optional = { ...(sourceOperator ? { sourceOperator } : {}), ...(callbackResolver ? { callbackResolver } : {}),
    ...(transport ? { rebuildTransport: () => transport.rebuildTransport() } : {}) }
  const executor = createHostAdminExecutor({ nodeId, engine, authorization, queries, ...optional, policy: {
    authorize: async () => {
      let pending: Seat.PendingSeatItem | undefined
      if (request.method === 'engine.approve' || request.method === 'engine.cancel') {
        let cursor: Seat.EngineCursor | undefined
        do {
          const page = await engine.pending({ limit, ...(cursor ? { cursor } : {}) })
          pending = page.items.find(item => item.queueItemId === request.params.queueItemId)
          if (pending || page.complete || !page.nextCursor) break
          cursor = page.nextCursor
        } while (current())
        if (!pending && request.method === 'engine.approve') return { status: 'rejected', error: { code: 'unauthorized', message: 'Approval target is unavailable',
          alternative: 'Query the durable operation before retrying', effectState: 'none', retryable: false } }
      }
      registration = issuers.register({ identity: { kind: 'local-operator', principalId: authority.principalId,
        origin: 'manual', nodeId, ...(pending ? { seat: pending.seat } : {}), taskIds: pending?.relatedTaskIds ?? [], policyRevision: 0 },
      current: () => current() ? { decision: 'allowed', reasonCode: 'authenticated-local-operator', policyRevision: 0 } : null })
      return registration.issuer
    },
  } })
  try { return await executor.execute(request, authority) }
  finally { registration?.dispose() }
}
