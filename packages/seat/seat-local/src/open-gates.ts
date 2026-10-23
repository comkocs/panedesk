/** Optional opening policies run before local admission writes or physical creation. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'

/** Evaluate the installed policy without changing behavior when it is absent.
 * @param ctx - local provider context.
 * @param context - trusted opening identity and candidates.
 * @returns the first refusal, or null when all policies allow.
 */
export async function openingGate(ctx: Context, context: T.GateContext): Promise<T.SeatRejected | null> {
  const results = await ctx.get('seatGates')?.evaluate(context)
  const denied = results?.find(result => result.outcome === 'deny')
  return denied?.outcome === 'deny' ? { status: 'rejected', error: denied.reason } : null
}

/** Construct an opening policy call from the owning operation.
 * @param nodeId - verified local node.
 * @param operationId - stable operation identity.
 * @param seat - selected seat, or null for traditional creation.
 * @returns common policy attribution.
 */
export function openingContext(nodeId: T.SeatNodeId, operationId: T.SeatOperationId, seat: T.SeatName | null): T.GateContextBase {
  return { nodeId, operationId, seat, sessionId: null, observedAt: new Date().toISOString(),
    callId: `open:${operationId}` as T.GateContext['callId'] }
}
