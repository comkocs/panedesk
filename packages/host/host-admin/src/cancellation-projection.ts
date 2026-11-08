/** Cancellation receipts written after issued authorization was removed. */
import type * as Seat from '@panedesk/dsh-seat'
import type { EngineProjection } from '@panedesk/dsh-seat-engine/src/projection.ts'

/** Attribution reference for a cancellation that no longer carries an issued grant.
 * @param operationId - Stable cancellation identity already accepted by the engine.
 * @returns The same text as an authorization reference, without consulting an issuer.
 */
function attribution(operationId: Seat.SeatOperationId): Seat.AuthorizationRef {
  return operationId as string as Seat.AuthorizationRef
}

/** Rebuild one retained cancellation from the committed queue effect.
 * New frames no longer carry an issued authorization, so the receipt uses the
 * operation identity itself as its attribution reference.
 * @param view - Replayed committed journal state.
 * @param request - Exact cancellation operation identity.
 * @returns Settled cancellation evidence, or undefined when this operation did not cancel.
 */
export function cancelledOperation(view: EngineProjection,
  request: Seat.SeatOperationQuery): Seat.SeatEngineOperationResult | undefined {
  const effect = view.decisions.flatMap(decision => decision.effects).find(item =>
    item.kind === 'queue/cancelled' && item.operationId === request.operationId)
  if (effect?.kind !== 'queue/cancelled') return undefined
  const pending = effect.data.pending
  const retained = effect.data.cancellation
  const cancellation: Seat.SeatCancellationRecord = retained?.authorizationId !== undefined ? retained : {
    authorizationId: attribution(request.operationId),
    principalId: retained?.principalId ?? effect.data.principalId, kind: retained?.kind ?? 'local-operator',
    operationId: request.operationId, queueItemId: pending.queueItemId,
    cancelledAt: retained?.cancelledAt ?? pending.queuedAt, stateVersion: retained?.stateVersion ?? pending.stateVersion,
    reasonPresent: retained?.reasonPresent ?? false,
  }
  return { status: 'settled', result: { status: 'cancelled', cancellation } }
}
