/** Execution evidence reads only the target Session log, never seat configuration. */
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatExecutionModelEvidence, SeatNodeId } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-session-query'
import type {} from '@panedesk/dsh-api-session-controller'

/** Capture the last recorded execution model without activating a Session.
 * @param ctx - Execution-node services.
 * @param sessionId - Accepted execution Session, or null before creation.
 * @param nodeId - Authenticated local node.
 * @returns Detached evidence; absent or unreadable records remain explicitly missing.
 */
export async function readExecutionModel(ctx: Context, sessionId: SessionId | null,
  nodeId: SeatNodeId): Promise<SeatExecutionModelEvidence> {
  const observedAt = new Date().toISOString()
  const missing: SeatExecutionModelEvidence = { status: 'missing', sessionId, nodeId, observedAt }
  if (sessionId === null) return missing
  let snapshot
  try { snapshot = await ctx.get('sessionQuery')?.readSession(sessionId) }
  catch (_error) { return missing /* Unreadable execution evidence must not substitute configured models. */ }
  if (!snapshot || snapshot.session.id !== sessionId) return missing
  for (const event of [...snapshot.events].reverse()) {
    const model = event.type === 'request/header' ? event.data.header.config
      : event.type === 'model/selection' ? event.data : undefined
    if (!model || !model.provider || !model.model) continue
    return { status: 'present', provider: model.provider, model: model.model,
      kind: event.type as 'request/header' | 'model/selection', sessionId, nodeId,
      recordRef: `${sessionId}:${event.seq}` as Extract<SeatExecutionModelEvidence, { status: 'present' }>['recordRef'], observedAt }
  }
  return missing
}
