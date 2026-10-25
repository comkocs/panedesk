/** Operation reads correlate committed queue transitions with their original trigger identities. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'

/** Project durable registration and progress without executing an operation.
 * @param view - Replayed committed journal state.
 * @param request - Exact operation identity.
 * @param nodeName - Configured display name of the journal owner.
 * @returns Safe registration and progress evidence, never frozen instruction content.
 */
export function queryOperation(view: EngineProjection, request: T.SeatOperationQuery, nodeName: string): T.SeatEngineOperationResult {
  const uncertain = [...view.callbacks.values()].find(item => item.nodeWorkChain?.route.originalOperationId === request.operationId
    && item.responseClass === 'unknown' && item.phase !== 'delivered')
  if (uncertain) return { status: 'pending', phase: 'configuring', stateVersion: view.sequence,
    progress: { kind: 'pending', reason: 'provider-unavailable', blockedBy: ['callback-outcome-unknown'] } }
  const effects = view.decisions.flatMap(decision => decision.effects)
  const owned = effects.filter(effect => effect.operationId === request.operationId
    || 'operationId' in effect.data && effect.data.operationId === request.operationId)
  const cancellation = view.cancellationOperations.get(request.operationId)
  if (cancellation) return { status: 'settled', result: { status: 'cancelled', cancellation } }
  const cancelled = owned.find(effect => effect.kind === 'queue/cancelled')
  if (cancelled?.kind === 'queue/cancelled' && cancelled.data.cancellation) return { status: 'settled',
    result: { status: 'cancelled', cancellation: cancelled.data.cancellation } }
  const approved = owned.find(effect => effect.kind === 'queue/approved')
  const approval = approved?.kind === 'queue/approved' ? {
    queueItemId: approved.data.pending.queueItemId, stateVersion: approved.data.pending.stateVersion,
  } : undefined
  const sources = approved?.kind === 'queue/approved' ? approved.data.pending.sources : []
  const open = [...view.opens.values()].find(item => item.openingOperationId === request.operationId
    || item.binding.kind === 'seat' && item.binding.openOperationId === request.operationId
    || sources.some(source => item.sources?.some(candidate => candidate.triggerId === source.triggerId
      && candidate.sourceId === source.sourceId)))
  const metadata = approval ? { approval } : {}
  if (open) {
    const progress = { kind: 'open' as const, phase: open.phase, sessionId: open.sessionId }
    if (open.failure) return { ...metadata, progress, status: 'settled', result: { status: 'rejected', error: open.failure } }
    if (open.phase === 'intent' || open.phase === 'creating') return { ...metadata, progress,
      status: 'pending', phase: open.phase, stateVersion: view.sequence }
    if (open.binding.kind === 'seat') return { ...metadata, progress, status: 'settled', result: {
      status: 'opened', sessionId: open.sessionId, seat: open.binding.seat, nodeId: open.binding.nodeId,
      nodeName, title: open.title ?? open.binding.seat, budget: open.budget.limits, phase: open.phase,
      stateVersion: view.sequence, callbackIds: [...view.callbacks.values()].filter(item =>
        item.payload.sessionId === open.sessionId).map(item => item.payload.callbackId),
    } }
  }
  if (approval) {
    const pending = view.pending.get(approval.queueItemId)
    if (pending) return { ...metadata, status: 'pending', phase: 'configuring', stateVersion: pending.stateVersion,
      progress: { kind: 'pending', reason: pending.reason, blockedBy: pending.blockedBy } }
    const cancelled = view.decisions.findLast(decision => decision.effects.some(effect => effect.kind === 'queue/cancelled'
      && effect.data.pending.queueItemId === approval.queueItemId))
    const refused = cancelled?.effects.find(effect => effect.kind === 'open/rejected')
    if (refused?.kind === 'open/rejected') return { ...metadata, status: 'settled', result: { status: 'rejected', error: refused.data.error } }
    if (cancelled) return { ...metadata, status: 'settled', result: { status: 'cancelled' }, progress: { kind: 'cancelled' } }
  }
  const last = owned.at(-1)
  if (!last) return { status: 'missing' }
  if (last.kind === 'window/closed' && last.data.endedAt !== null) return { status: 'settled', result: {
    status: 'closed', sessionId: last.data.sessionId, phase: 'closed', endedAt: last.data.endedAt, stateVersion: last.data.stateVersion,
  } }
  if (last.kind === 'open/rejected') return { status: 'settled', result: { status: 'rejected', error: last.data.error } }
  return { status: 'pending', phase: last.kind === 'window/replacement' ? last.data.phase : 'configuring', stateVersion: owned.length }
}
