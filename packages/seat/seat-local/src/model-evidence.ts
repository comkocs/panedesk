/** Execution evidence reads only the target Session log, never seat configuration. */
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatExecutionModelEvidence, SeatNodeId } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-session-query'
import type {} from '@panedesk/dsh-api-session-controller'
import type {} from '@panedesk/dsh-session-ledger'
import { setTimeout as delay } from 'node:timers/promises'

async function admitted(ctx: Context, sessionId: SessionId, seq: number, deadline: number): Promise<boolean> {
  const ledger = ctx.get('sessionLedger')
  if (ledger === undefined) return false
  while (performance.now() < deadline) {
    const snapshot = await ledger.snapshot({ sessionId })
    if (performance.now() >= deadline) return false
    if (snapshot.complete && snapshot.rows.some(row => row.kind === 'call'
      && row.start.sessionId === sessionId && row.start.purpose === 'conversation'
      && row.start.requestHeaderSeq === seq)) return true
    await delay(Math.min(25, Math.max(0, deadline - performance.now())))
  }
  return false
}

/** Capture the last recorded execution model without activating a Session.
 * @param ctx - Execution-node services.
 * @param sessionId - Accepted execution Session, or null before creation.
 * @param nodeId - Authenticated local node.
 * @param waitMs - Maximum wait for the exact request-header sequence to be accounted, including storage reads.
 * @returns Detached evidence; absent, unaccounted or unreadable records remain explicitly missing.
 */
export async function readExecutionModel(ctx: Context, sessionId: SessionId | null,
  nodeId: SeatNodeId, waitMs = 1000): Promise<SeatExecutionModelEvidence> {
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
    if (event.type === 'request/header') {
      const timeout = new AbortController()
      try {
        const ready = await Promise.race([
          admitted(ctx, sessionId, event.seq, performance.now() + waitMs),
          delay(waitMs, false, { signal: timeout.signal }),
        ])
        if (!ready) return missing
      } catch (_error) { return missing /* Accounting read failures are not execution evidence. */ }
      finally { timeout.abort() }
    }
    return { status: 'present', provider: model.provider, model: model.model,
      kind: event.type as 'request/header' | 'model/selection', sessionId, nodeId,
      recordRef: `${sessionId}:${event.seq}` as Extract<SeatExecutionModelEvidence, { status: 'present' }>['recordRef'], observedAt }
  }
  return missing
}
