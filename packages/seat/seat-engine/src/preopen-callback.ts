/** Pre-open cancellation and owner notification are constructed in one synchronous journal transaction. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import { digest, EngineError } from './journal.ts'
import { fact } from './triggers.ts'
import { frozenItems, hasNoFrozenExecution, sameFrozenSource, type FrozenItem, type FrozenHistory } from './frozen-terminal.ts'

/** Construct one original item's rejected delivery without reading external model or owner services.
 * @param view - Serialized committed history.
 * @param item - Original frozen admission.
 * @param cancellation - Queue cancellation committed with or before this delivery.
 * @param reason - Safe no-effect terminal reason.
 * @param nodeName - Executing node display name.
 * @param observedAt - This notification's observation time, retained on replay.
 * @returns One new pending fact, or no fact when the identical delivery is already retained.
 */
export function preopenCallback(view: FrozenHistory, item: FrozenItem,
  cancellation: Extract<T.EngineEffect, { kind: 'queue/cancelled' }>, reason: T.SeatFailure,
  nodeName: string, observedAt: string): T.EngineEffect[] {
  if (reason.effectState !== 'none' || !hasNoFrozenExecution(view, item)) {
    throw new EngineError('state-conflict', 'Pre-open execution absence is unconfirmed')
  }
  const callbackId = digest(['seat-preopen-rejected/v1', item.nodeId, item.chain.operationKey,
    item.pending.queueItemId, item.source.sourceId, item.source.triggerId]) as string as T.CallbackId
  const existing = view.decisions.flatMap(frame => frame.effects).find(effect =>
    (effect.kind === 'callback/pending' || effect.kind === 'callback/attempted' || effect.kind === 'callback/delivered')
    && effect.data.payload.callbackId === callbackId)
  const payload: T.SeatCallbackPayload = { callbackId, sourceId: item.source.sourceId, triggerId: item.source.triggerId,
    stateVersion: cancellation.data.revision, seat: item.pending.seat, title: item.pending.frozenOpen?.title ?? null,
    sessionId: null, nodeId: item.nodeId, nodeName, budget: {},
    ...(item.source.taskId ? { taskId: item.source.taskId } : {}), relatedTaskIds: item.pending.relatedTaskIds,
    kind: 'rejected', reason: structuredClone(reason) }
  if (existing && (existing.kind === 'callback/pending' || existing.kind === 'callback/attempted' || existing.kind === 'callback/delivered')) {
    if (existing.data.payloadDigest !== digest(payload) || !existing.data.nodeWorkChain
      || digest(existing.data.nodeWorkChain.route) !== digest(item.chain.route)) {
      throw new EngineError('operation-id-conflict', 'Pre-open callback identity conflicts')
    }
    return []
  }
  const modelEvidence: T.SeatExecutionModelEvidence = { status: 'missing', sessionId: null, nodeId: item.nodeId, observedAt }
  const body = { callback: payload, route: structuredClone(item.chain.route), modelEvidence }
  const data: T.SeatCallbackDelivery = { payload, payloadDigest: digest(payload), attempt: 0,
    phase: 'pending', nextDue: null, responseClass: null, nodeWorkChain: { ...body, payloadDigest: digest(body) } }
  return [fact({ kind: 'callback/pending', seat: item.pending.seat, triggerId: item.source.triggerId,
    operationId: item.chain.operationKey.operationId, causedBy: cancellation.eventId, data })]
}

/** Append notifications for every original frozen source, or fail the complete cancellation.
 * @param view - Latest committed history under the journal writer.
 * @param effects - Original cancellation and optional refusal facts.
 * @param reason - Safe terminal reason.
 * @param nodeName - Executing node display name.
 * @returns Cancellation and callbacks ready for one atomic append; non-frozen paths are unchanged.
 */
export function withPreopenCallbacks(view: EngineProjection, effects: readonly T.EngineEffect[],
  reason: T.SeatFailure, nodeName: string): T.EngineEffect[] {
  const result = [...effects]
  for (const effect of effects) {
    if (effect.kind !== 'queue/cancelled' || !effect.data.pending.frozenOpen?.nodeWorkChain) continue
    const pending = effect.data.pending
    const items = frozenItems(view).filter(item => item.pending.queueItemId === pending.queueItemId)
    if (!items.length || pending.sources.some(source => items.filter(item => sameFrozenSource(item, source)).length !== 1)) {
      throw new EngineError('state-conflict', 'Pre-open frozen admission is ambiguous')
    }
    for (const item of items) result.push(...preopenCallback(view, item, effect, reason, nodeName, new Date().toISOString()))
  }
  return result
}
