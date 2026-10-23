/** Context estimates are reconstructed from committed compactions and the latest complete call. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-compaction'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatContextUsage, SeatOperationId } from '@panedesk/dsh-seat'
import type { LocalEngineState } from './engine-state.ts'
import type { LocalSeatRuntime } from './service-options.ts'

/** Read a recoverable context epoch without treating a compaction summary call as the next normal context.
 * @param ctx - public query and ledger providers.
 * @param sessionId - exact target session.
 * @returns complete dated estimate, or explicit unknown.
 */
export async function readContextUsage(ctx: Context, sessionId: SessionId): Promise<SeatContextUsage> {
  const observedAt = new Date().toISOString()
  const [ledger, saved] = await Promise.all([
    ctx.get('sessionLedger')?.query({ sessionId }), ctx.get('sessionQuery')?.readSession(sessionId),
  ])
  if (!ledger?.complete || !saved) return { status: 'unknown', observedAt }
  const compactions = saved.events.filter(event => event.type === 'compaction/end' && event.data.error === undefined)
  const contextEpoch = new Set(compactions.map(event => event.type === 'compaction/end' ? event.data.compactionId : '')).size
  const compactedAt = compactions.at(-1)?.time ?? 0
  const call = ledger.rows.findLast(row => row.kind === 'call' && row.start.purpose === 'conversation' && row.finish !== undefined)
  if (call?.kind !== 'call' || !call.finish || call.finish.observedAt <= compactedAt) return { status: 'unknown', observedAt }
  const usage = call.finish.usage
  const values = [usage?.inputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens]
  if (values.some(value => value === undefined || !Number.isFinite(value) || value < 0)) return { status: 'unknown', observedAt }
  return { status: 'known', source: 'last-call-usage', tokens: values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    observedAt, estimated: true, contextEpoch }
}

/** Deliver a threshold reminder with an epoch-stable M5 identity.
 * @param ctx - public runtime services.
 * @param state - durable seat bindings.
 * @param runtime - active delivery adapter.
 * @param sessionId - window whose latest call settled.
 */
export async function remindContext(ctx: Context, state: LocalEngineState, runtime: LocalSeatRuntime, sessionId: SessionId): Promise<void> {
  const facts = (await state.read()).effects
  const child = facts.findLast(effect => (effect.kind === 'child/admitted' || effect.kind === 'child/released')
    && effect.data.childSessionId === sessionId)
  if (child?.kind === 'child/released') return
  const parentSessionId = child?.kind === 'child/admitted' ? child.data.parentSessionId : sessionId
  const open = facts.findLast(effect => (effect.kind === 'open/created' || effect.kind === 'open/configured')
    && effect.data.sessionId === parentSessionId)
  if (open?.kind !== 'open/created' && open?.kind !== 'open/configured') return
  const definition = open.data.definition
  if (!definition) return
  const threshold = child ? definition.subagentContextThresholdTokens : definition.contextThresholdTokens
  if (threshold === undefined) return
  const usage = await readContextUsage(ctx, sessionId)
  if (usage.status !== 'known' || usage.tokens < threshold) return
  await runtime.send({ sessionId, operationId: `${sessionId}:context:${definition.revision}:${usage.contextEpoch}` as SeatOperationId,
    mode: 'steer', text: child
      ? 'The child context reached its limit. Prepare a handoff summary for a new subagent.'
      : 'Context threshold reached. Consider replacing this window after reporting its pending work.' })
}
