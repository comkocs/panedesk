/** Observe an abandoned first handoff without resuming its Session or replaying work. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { LocalEngineState, localFact } from './engine-state.ts'
import { digest } from './store.ts'

const restartFailure = 'The host restarted after opening; its previous owner is dead and the first turn was never executed.'

function latestOpen(effects: readonly T.EngineEffect[], sessionId: SessionId): T.EngineOpenData | undefined {
  const last = effects.findLast(effect => (effect.kind === 'open/intent' || effect.kind === 'open/created'
    || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') && effect.data.sessionId === sessionId)
  return last && (last.kind === 'open/intent' || last.kind === 'open/created'
    || last.kind === 'open/configured' || last.kind === 'open/opening-failed') ? last.data : undefined
}

/** Record only a proven unconsumed handoff after durable owner death.
 * @param ctx - Local services; no Session is acquired by this observation.
 * @param state - Engine journal adapter.
 * @param sessionId - Original window identity whose owner was observed dead.
 * @returns Whether the fenced, unclaimed opening can enter automatic close recovery.
 */
export async function recordOrphanedOpening(ctx: Context, state: LocalEngineState, sessionId: SessionId): Promise<boolean> {
  const effects = (await state.read()).effects, open = latestOpen(effects, sessionId)
  const failed = open?.phase === 'opening-failed' && open.failure?.cause?.domain === 'seat-local'
    && open.failure.cause.code === 'opening-owner-lost'
  if (!open || (open.phase !== 'opening-pending' && !failed) || !open.openingMessageId || open.openingMode === 'prefill'
    || effects.some(effect => effect.kind === 'window/closed' && effect.data.sessionId === sessionId)) return false
  const resource = effects.findLast(effect => (effect.kind === 'resource/reserved' || effect.kind === 'resource/released')
    && effect.data.owner.sessionId === sessionId)
  if (resource?.kind !== 'resource/released'
    || !['holder-death', 'host-restart-recovery'].includes(resource.data.reason)) return false
  const delivery = ctx.get('messageDelivery'), query = ctx.get('sessionQuery')
  if (!delivery || !query) return false
  const messageId = open.openingMessageId
  const status = await delivery.status(messageId)
  if (!(status.state === 'queued' && status.phase === 'pending') && !(failed && status.state === 'withdrawn')) return false
  const snapshot = await query.readSession(sessionId)
  if (snapshot.events.some(event => event.type === 'user/message' && event.data.id === open.openingMessageId
    || event.type === 'agent/input/transition' && event.data.messageIds.includes(messageId)
      && ['claimed', 'appended', 'dispatched'].includes(event.data.phase))) return false
  if (failed) return true
  return state.mutate((current) => {
    const retained = latestOpen(current, sessionId)
    if (retained?.phase !== 'opening-pending' || retained.openingMessageId !== open.openingMessageId
      || ctx.get('agents')?.get(sessionId) || current.some(effect => effect.kind === 'window/closed' && effect.data.sessionId === sessionId)) {
      return { result: false, effects: [] }
    }
    return { result: true, effects: [localFact({ kind: 'open/opening-failed', sessionId,
      data: { ...retained, phase: 'opening-failed', failure: { code: 'opening-failed', message: restartFailure,
        alternative: 'Close this window normally; use manual resend or wake to reassign the unexecuted work.',
        retryable: false, effectState: 'partial', cause: { domain: 'seat-local', code: 'opening-owner-lost',
          reason: restartFailure, effectState: 'partial', retryable: false,
          operationId: retained.openingOperationId, nodeId: retained.binding.nodeId } } } })] }
  })
}

/** Withdraw only this window's unclaimed opening after its owner was durably fenced.
 * @param ctx - Real caller context preserves the original sender check.
 * @param state - Authoritative engine facts.
 * @param sessionId - Window admitted with its current close revision.
 * @returns Whether the durable withdrawal was applied; all other outcomes keep ordinary busy checks.
 */
export async function withdrawOrphanedOpening(ctx: Context, state: LocalEngineState, sessionId: SessionId): Promise<boolean> {
  const effects = (await state.read()).effects, open = latestOpen(effects, sessionId)
  if (!open?.openingMessageId || open.openingMode === 'prefill'
    || (open.phase !== 'opening-pending' && !(open.phase === 'opening-failed'
      && (open.failure?.cause?.domain === 'seat-local' && open.failure.cause.code === 'opening-owner-lost'
        || open.failure?.message === restartFailure)))) return false
  const resource = effects.findLast(effect => (effect.kind === 'resource/reserved' || effect.kind === 'resource/released')
    && effect.data.owner.sessionId === sessionId)
  if (resource?.kind !== 'resource/released'
    || !['holder-death', 'host-restart-recovery'].includes(resource.data.reason)) return false
  const delivery = ctx.get('messageDelivery')
  if (!delivery) return false
  const status = await delivery.status(open.openingMessageId)
  if (status.state !== 'queued' || status.phase !== 'pending') return false
  const result = await delivery.withdraw({ messageId: open.openingMessageId, expectedRevision: status.revision,
    operationId: digest(['orphaned-opening-close', open.intentId, open.openingMessageId, status.revision]) as string as OperationId })
  return result.kind === 'applied' && result.status.state === 'withdrawn'
}
