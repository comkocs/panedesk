/** Callback resolution changes only the existing delivery state. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineJournal } from './journal.ts'
import { resolvedCallback } from './callback-retention.ts'
import { fact } from './triggers.ts'

/** Resolve one paused callback while holding the journal serialization slot.
 * @param journal - Recovered writer and callback history.
 * @param request - Original callback, action and expected attempt.
 * @returns Current state on a repeated action, or a fixed zero-frame refusal.
 */
export async function resolveCallback(journal: EngineJournal,
  request: T.CallbackResolveRequest): Promise<T.CallbackResolveResult> {
  let result: T.CallbackResolveResult = { status: 'rejected', code: 'callback-unknown' }
  await journal.commitAuthorization((view) => {
    const delivery = view.callbacks.get(request.callbackId)
    if (!delivery) { result = { status: 'rejected', code: 'callback-unknown' }; return [] }
    const code = `callback-manually-${request.action === 'resume' ? 'resumed' : 'abandoned'}`
    let replay = false
    for (const decision of view.decisions) for (const effect of decision.effects) {
      if (effect.kind !== 'callback/attempted' || effect.data.payload.callbackId !== request.callbackId) continue
      if (effect.data.phase === 'paused') replay = false
      else if (effect.data.attempt === request.expectedAttempt && effect.data.lastDiagnostic?.cause.code === code) replay = true
    }
    if (replay) {
      result = { status: 'ok', callbackId: request.callbackId, phase: delivery.phase, attempt: delivery.attempt }
      return []
    }
    if (delivery.phase !== 'paused') { result = { status: 'rejected', code: 'callback-not-paused' }; return [] }
    if (delivery.attempt !== request.expectedAttempt) { result = { status: 'rejected', code: 'callback-attempt-conflict' }; return [] }
    const updated = resolvedCallback(view, delivery, request.action, Date.now())
    result = { status: 'ok', callbackId: request.callbackId, phase: updated.phase, attempt: updated.attempt }
    return [fact({ kind: 'callback/attempted',
      ...(delivery.payload.sessionId ? { sessionId: delivery.payload.sessionId } : {}), data: updated })]
  })
  return result
}
