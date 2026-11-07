/** Authorized cancellation settles only unopened work in the existing journal transaction. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { fact, rejected } from './triggers.ts'
import { withPreopenCallbacks } from './preopen-callback.ts'
import { preopenCancelledReason } from './frozen-terminal.ts'

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
  caller: { principalId: T.SeatPrincipalId; nodeId: T.SeatNodeId }): { result: T.PendingSeatMutationResult; effects: AuthorizationDecision['effects'] } {
  const refuse = (result: T.SeatRejected) => ({ result, effects: [] })
  if (!validCancellationReason(request.reason)) return refuse(rejected('invalid-request', 'Cancellation reason exceeds 512 UTF-8 bytes or contains controls'))
  const replay = view.authorizationDecisions.find(decision => decision.effects.some(effect =>
    effect.kind === 'queue/cancelled' && effect.data.cancellation?.operationId === request.operationId))
  if (replay) {
    const cancelled = replay.effects.find(effect => effect.kind === 'queue/cancelled')
    if (cancelled?.kind !== 'queue/cancelled' || !cancelled.data.cancellation
      || cancelled.data.cancellation.principalId !== caller.principalId) {
      return refuse(rejected('operation-id-conflict', 'Cancellation identity conflicts'))
    }
    return { result: { status: 'cancelled', queueItemId: cancelled.data.pending.queueItemId,
      stateVersion: cancelled.data.revision }, effects: [] }
  }
  if (view.decisions.some(decision => decision.effects.some(effect => effect.operationId === request.operationId))) {
    return refuse(rejected('operation-id-conflict', 'Cancellation identity conflicts'))
  }
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
      operationId: request.operationId, nodeId: caller.nodeId } } })
  }
  if (previous.stateVersion !== request.expectedStateVersion) return refuse(rejected('revision-conflict', 'Pending state changed'))
  const pending = { ...previous, stateVersion: previous.stateVersion + 1 }
  const cancellation: T.SeatCancellationRecord = { principalId: caller.principalId,
    kind: 'human', operationId: request.operationId, queueItemId: pending.queueItemId,
    cancelledAt: new Date().toISOString(), stateVersion: pending.stateVersion, reasonPresent: request.reason !== undefined,
    ...(request.reason !== undefined ? { reason: request.reason } : {}) }
  return { result: { status: 'cancelled', queueItemId: pending.queueItemId, stateVersion: pending.stateVersion },
    effects: [...withPreopenCallbacks(view, [fact({ kind: 'queue/cancelled', operationId: request.operationId, data: { pending, cancellation,
      principalId: caller.principalId, previousRevision: previous.stateVersion, revision: pending.stateVersion } })],
    preopenCancelledReason(), caller.nodeId)] }
}
