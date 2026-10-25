/** Authorized cancellation settles only unopened work in the existing journal transaction. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { authorizationEffect } from './authorization-issuer.ts'
import { digest } from './journal.ts'
import { fact, rejected } from './triggers.ts'

/** Validate the bounded operator reason at request and durable JSON entry points.
 * @param value - Optional untrusted cancellation reason.
 * @returns Whether the UTF-8 text fits and contains no control characters.
 */
export function validCancellationReason(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}
/** Prepare cancellation and attribution against the latest committed state.
 * @param view - Serialized journal projection.
 * @param request - Queue revision and exact action identity.
 * @param data - Verified current entry attribution.
 * @returns Mutation reply and the effects committed together, or no effects on refusal.
 */
export function cancelEffects(view: EngineProjection, request: T.CancelPendingSeatRequest,
  data: T.SeatIssuedAuthorizationFact): { result: T.PendingSeatMutationResult; effects: AuthorizationDecision['effects'] } {
  const refuse = (result: T.SeatRejected) => ({ result, effects: [] })
  if (!validCancellationReason(request.reason)) return refuse(rejected('invalid-request', 'Cancellation reason exceeds 512 UTF-8 bytes or contains controls'))
  const replay = view.authorizationDecisions.find(decision => decision.effects.some(effect =>
    effect.kind === 'authorization/checked' && effect.data.operationId === request.operationId))
  if (replay) {
    const original = replay.effects.find(effect => effect.kind === 'authorization/checked')
    const cancelled = replay.effects.find(effect => effect.kind === 'queue/cancelled')
    if (original?.kind !== 'authorization/checked' || original.data.requestDigest !== digest(request)
      || original.data.principalId !== data.principalId || original.data.kind !== data.kind
      || original.data.callId !== data.callId || original.data.rootCallId !== data.rootCallId) {
      return refuse(rejected('operation-id-conflict', 'Cancellation identity conflicts'))
    }
    if (original.data.decision === 'denied') return refuse(rejected('unauthorized', 'Cancellation policy denied the operation'))
    if (data.decision !== 'allowed') return refuse(rejected('unauthorized', 'Cancellation policy denied the operation'))
    if (cancelled?.kind !== 'queue/cancelled' || !cancelled.data.cancellation) {
      return refuse(rejected('operation-id-conflict', 'Cancellation identity conflicts'))
    }
    return { result: { status: 'cancelled', queueItemId: cancelled.data.pending.queueItemId,
      stateVersion: cancelled.data.revision }, effects: [] }
  }
  if (view.decisions.some(decision => decision.effects.some(effect => effect.operationId === request.operationId))) {
    return refuse(rejected('operation-id-conflict', 'Cancellation identity conflicts'))
  }
  if (data.decision !== 'allowed') return { result: rejected('unauthorized', 'Cancellation policy denied the operation'),
    effects: [authorizationEffect(data)] }
  const previous = view.pending.get(request.queueItemId)
  if (!previous) {
    const dispatched = view.decisions.find(decision => decision.effects.some(effect => effect.kind === 'queue/cancelled'
      && effect.data.pending.queueItemId === request.queueItemId) && decision.effects.some(effect => effect.kind === 'open/intent'))
    const intent = dispatched?.effects.find(effect => effect.kind === 'open/intent')
    const open = intent?.kind === 'open/intent' ? view.opens.get(intent.data.sessionId) : undefined
    const reasonCode: T.SeatCancellationReasonCode = !open ? 'queue-item-unknown'
      : open.phase === 'intent' || open.phase === 'creating' ? 'queue-item-dispatched' : 'queue-item-opened'
    const result = rejected('revision-conflict', 'Pending state changed')
    return refuse({ ...result, error: { ...result.error, cause: { domain: 'seat-engine', code: result.error.code,
      reason: 'Cancellation requires an undispatched queue item', reasonCode, effectState: 'none', retryable: false,
      operationId: request.operationId, nodeId: data.nodeId } } })
  }
  if (previous.stateVersion !== request.expectedStateVersion) return refuse(rejected('revision-conflict', 'Pending state changed'))
  if (data.seat !== previous.seat || previous.relatedTaskIds.some(task => !data.taskIds.includes(task))) {
    return refuse(rejected('unauthorized', 'Cancellation attribution does not cover this pending seat and its tasks'))
  }
  const pending = { ...previous, stateVersion: previous.stateVersion + 1 }
  const cancellation: T.SeatCancellationRecord = { authorizationId: data.authorizationId, principalId: data.principalId,
    kind: data.kind, operationId: request.operationId, queueItemId: pending.queueItemId,
    cancelledAt: new Date().toISOString(), stateVersion: pending.stateVersion, reasonPresent: request.reason !== undefined,
    ...(request.reason !== undefined ? { reason: request.reason } : {}) }
  return { result: { status: 'cancelled', queueItemId: pending.queueItemId, stateVersion: pending.stateVersion },
    effects: [fact({ kind: 'queue/cancelled', operationId: request.operationId, data: { pending, cancellation,
      principalId: data.principalId, previousRevision: previous.stateVersion, revision: pending.stateVersion } }),
    authorizationEffect(data)] }
}
