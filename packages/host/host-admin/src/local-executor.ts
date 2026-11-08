/** Running-host assembly reads business projections without an authorization service. */
import type { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-seat-engine'
import { SeatEngine, queryTasks, queryOperation } from '@panedesk/dsh-seat-engine'
import { cancelledOperation } from './cancellation-projection.ts'
import { createHostAdminExecutor } from './executor.ts'
import type { HostAdminAuthority, HostAdminEndpoint, HostAdminRequest, HostAdminResponse } from './index.ts'

/** Assemble the real transaction adapter without installing or starting another engine.
 * @param ctx - Running provider context.
 * @param request - Authenticated and validated request.
 * @param authority - Exact transport-owned operator identity.
 * @param nodeId - Configured local node.
 * @param _limit - Pending scan page bound retained by the host signature.
 * @param current - Whether this administration lifecycle still owns its credential.
 * @returns Provider response, or null when required capabilities are absent.
 */
export async function executeLocal(ctx: Context, request: HostAdminRequest, authority: HostAdminAuthority,
  nodeId: HostAdminEndpoint['nodeId'], _limit: number, current: () => boolean): Promise<HostAdminResponse | null> {
  const engine = ctx.get('seatEngine')
  if (!engine || !current()) return null
  const sourceOperator = ctx.get('hostAdminSourceOperator')
  const resolve = engine.callbackResolve?.bind(engine)
  const callbackResolver = resolve ? {
    callbackResolve: (params: import('./index.ts').HostAdminCallbackResolveRequest) => resolve(params),
  } : undefined
  const transport = ctx.get('hostAdminTransport')
  const optional = { ...(sourceOperator ? { sourceOperator } : {}), ...(callbackResolver ? { callbackResolver } : {}),
    ...(engine instanceof SeatEngine ? {
      tasks: async (params: Seat.SeatTaskQueryRequest) => {
        await engine.ready()
        return queryTasks(engine.journal.projection.decisions, params)
      },
      operation: async (params: Seat.SeatOperationQuery) => {
        await engine.ready()
        const view = engine.journal.projection
        const projected = queryOperation(view, params, engine.options.config.nodeName)
        const recorded = projected.status === 'settled' && projected.result.status === 'cancelled' && 'cancellation' in projected.result
        const retained = !recorded && projected.status !== 'settled' ? cancelledOperation(view, params) : undefined
        return retained ?? projected
      },
    } : {}),
    ...(transport ? { rebuildTransport: (peerNodeId?: Seat.SeatNodeId) => transport.rebuildTransport(peerNodeId) } : {}) }
  const executor = createHostAdminExecutor({ nodeId, engine, ...optional })
  return executor.execute(request, authority)
}
