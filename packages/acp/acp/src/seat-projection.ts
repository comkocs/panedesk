/** ACP opt-in seat operations use the same wire decoder and authority as SDK calls. */
import type { Context } from '@panedesk/cordis'
import { decodeSeatRequest, type SeatRequestMap } from '@panedesk/dsh-sdk-protocol'
import type { SeatCallContext } from '@panedesk/dsh-seat'
import { hostProjection, isHostProjection } from '@panedesk/dsh-sdk-jsonrpc-server'

/** Fixed ACP extension methods; message sends retain their existing extension. */
export const ACP_HOST_METHODS = ['seats/open', 'seats/openBatch', 'seats/renew', 'seats/close', 'seats/replace', 'seats/wake',
  'nodes/list', 'nodes/status', 'authorizations/query'] as const

/** Dispatch only a negotiated method under transport-owned local authority.
 * @param ctx - ACP host context, never a JSON-supplied context.
 * @param method - Negotiated fixed projection name.
 * @param params - Raw request without caller authority.
 * @returns Original provider outcome, preserving node and operation identities.
 */
export async function acpHostProjection(ctx: Context, method: typeof ACP_HOST_METHODS[number], params: unknown): Promise<unknown> {
  if (ctx.agents.currentInitiator() !== undefined) throw new Error('Host operations require the local owner')
  if (isHostProjection(method)) return hostProjection(ctx, method, params)
  const seats = ctx.get('seats'), engine = ctx.get('seatEngine')
  if (seats === undefined || engine === undefined) throw new Error('Seat operations are unavailable')
  const node = await engine.nodeStatus()
  const authority: SeatCallContext = { principalId: 'owner' as SeatCallContext['principalId'], origin: 'remote', nodeId: node.nodeId }
  const service = seats.withAuthority(authority)
  const opening = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? { ...params, origin: 'remote', openingMode: 'auto' } : params
  switch (method) {
    case 'seats/open': return service.open(decodeSeatRequest(method, opening))
    case 'seats/openBatch': return service.openBatch(decodeSeatRequest(method, opening))
    case 'seats/renew': return service.renew(decodeSeatRequest(method, params))
    case 'seats/close': return service.close(decodeSeatRequest(method, params))
    case 'seats/replace': return service.replace(decodeSeatRequest(method, params))
    case 'seats/wake': return service.wake(decodeSeatRequest(method, params))
  }
}

/** ACP method subset is checked against the existing SDK request map. */
export type AcpSeatMethods = Extract<typeof ACP_HOST_METHODS[number], keyof SeatRequestMap>
