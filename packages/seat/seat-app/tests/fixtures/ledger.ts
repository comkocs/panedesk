import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import { recordCost } from '../../../seat-local/tests/ledger-call.ts'
import type { EngineEffect, SeatCallbackPayload } from '@panedesk/dsh-seat'

export { recordCost }

export async function evidence(ctx: Context, sessionId: SessionId) {
  const session = await ctx.sessionQuery.readSession(sessionId)
  const ledger = await ctx.sessionLedger.query({ sessionId })
  const page = await ctx.seatEngine.query({ limit: 10000 })
  const engine = { ...page, effects: page.effects.filter(effect => effect.sessionId === sessionId) }
  return { session, ledger, engine }
}

export function openingFacts(effects: readonly EngineEffect[]) {
  const values = new Map<string, Extract<EngineEffect, { kind: 'open/intent' }>['data']>()
  for (const effect of effects) if (effect.kind === 'open/intent' || effect.kind === 'open/created' || effect.kind === 'open/configured') {
    values.set(effect.data.sessionId, effect.data)
  }
  return [...values.values()]
}

export function uniqueCallbacks(callbacks: readonly SeatCallbackPayload[]) {
  return [...new Map(callbacks.map(payload => [payload.callbackId, payload])).values()]
}
