/** Close publication releases resources and queues callbacks in one durable frame. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import { digest, EngineError } from './journal.ts'
import { fact } from './triggers.ts'

/** Build terminal facts only from a provider-confirmed close.
 * @param view - current committed state.
 * @param closed - flushed close outcome.
 * @param nodeName - configured display alias.
 * @returns atomic close, resource release and callback effects.
 */
export function closeEffects(view: EngineProjection, closed: T.EngineCloseData, nodeName: string): T.EngineEffect[] {
  if (closed.phase !== 'closed' || !closed.endedAt || !Number.isFinite(Date.parse(closed.endedAt))) {
    throw new EngineError('invalid-request', 'Close publication requires a flushed terminal timestamp')
  }
  const previous = view.closed.get(closed.sessionId)
  if (previous) {
    if (digest(previous) !== digest(closed)) throw new EngineError('state-conflict', 'Terminal close already exists')
    return []
  }
  const open = view.opens.get(closed.sessionId), resource = view.resources.get(closed.sessionId)
  if (!open || open.binding.kind !== 'seat') throw new EngineError('session-not-found', 'Engine window is unavailable')
  const binding = open.binding
  const effects: T.EngineEffect[] = [fact({ kind: 'window/closed', sessionId: closed.sessionId, seat: binding.seat, data: closed })]
  if (resource) effects.push(fact({ kind: 'resource/released', sessionId: closed.sessionId, seat: binding.seat, data: {
    owner: resource.owner, reason: closed.reason === 'replaced' ? 'replacement-handover' : 'window-closed',
    observedAt: closed.endedAt, engineReadyAt: null, releasedAt: new Date().toISOString(), fenced: true,
  } }))
  if (resource) {
    const replacement = [...view.replacements.values()].find(item => item.oldSessionId === closed.sessionId
      && item.newSessionId && !item.failure && item.phase !== 'failed' && item.phase !== 'completed')
    const next = replacement?.newSessionId ? view.resources.get(replacement.newSessionId) : undefined
    if (next) effects.push(fact({ kind: 'resource/reserved', sessionId: next.owner.sessionId,
      data: { ...next, exclusiveTags: resource.exclusiveTags } }))
  }
  for (const source of open.sources ?? []) {
    const payload: T.SeatCallbackPayload = {
      kind: 'window-ended', callbackId: digest([open.intentId, source.triggerId, 'window-ended']) as string as T.CallbackId,
      sourceId: source.sourceId, triggerId: source.triggerId, stateVersion: view.sequence + 1,
      seat: binding.seat, title: open.title ?? binding.seat, sessionId: closed.sessionId,
      nodeId: binding.nodeId, nodeName, budget: view.budgets.get(closed.sessionId)?.limits ?? open.budget.limits,
      ...(source.taskId ? { taskId: source.taskId } : {}), relatedTaskIds: binding.relatedTaskIds,
      reason: closed.reason, ...(closed.detail ? { detail: closed.detail } : {}), endedAt: closed.endedAt, selfReport: closed.selfReport,
      selfReportStatus: closed.selfReportStatus, ...(closed.reportId ? { reportId: closed.reportId } : {}),
    }
    effects.push(fact({ kind: 'callback/pending', sessionId: closed.sessionId, data: {
      payload, payloadDigest: digest(payload), attempt: 0, phase: 'pending', nextDue: null, responseClass: null,
    } }))
  }
  return effects
}
