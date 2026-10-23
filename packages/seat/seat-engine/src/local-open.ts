/** Local opening submits the same durable source identity as the provider ingress. */
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { digest } from './journal.ts'
import { rejected } from './triggers.ts'

/** Admit authenticated frozen input without allocating a second local identity.
 * @param engine - node owner.
 * @param input - provider-validated request and frozen configuration.
 * @param accept - engine admission retaining the authenticated frozen snapshot.
 * @returns the retained queue or window result, including unsent prefill text.
 */
export async function openLocalWindow(engine: SeatEngine, input: T.SeatLocalOpenRequest,
  accept: (envelope: T.TriggerEnvelope) => Promise<T.AcceptTriggerResult>): Promise<T.OpenSeatResult> {
  const { request, authority, definition } = input
  if (authority.nodeId !== engine.options.nodeId || (request.nodeId && request.nodeId !== authority.nodeId)) {
    return rejected('cross-node-unsupported', 'Opening is node-local')
  }
  if (authority.origin !== request.origin || request.origin === 'engine') return rejected('unauthorized', 'Opening requires authenticated manual ingress')
  if (definition.seat !== request.seat) return rejected('invalid-request', 'Frozen definition targets another seat')
  const sourceId = 'seat-local-manual' as T.SeatSourceId
  const triggerId = digest(request.operationId) as string as T.TriggerId
  const data = JSON.parse(JSON.stringify({ request, opening: input.opening, title: input.title, definition })) as T.SeatJson
  const result = await accept({ triggerId, sourceId, eventId: triggerId as string as T.SourceEventId,
    kind: 'manual', evidence: { kind: 'manual', origin: request.origin, operationId: request.operationId },
    seat: request.seat, projectId: definition.projectId, receivedAt: new Date().toISOString(), data, dataDigest: digest(data),
    callbackRef: sourceId, ...(request.taskId === undefined ? {} : { taskId: request.taskId }) })
  if (result.status === 'rejected') return result
  await engine.drive()
  const view = engine.journal.projection
  const open = [...view.opens.values()].find(item => item.sources?.some(source => source.triggerId === triggerId))
  if (open) {
    const window: T.OpenedSeatWindow = { sessionId: open.sessionId, seat: request.seat, nodeId: authority.nodeId,
      nodeName: engine.options.config.nodeName, title: open.title ?? input.title,
      budget: view.budgets.get(open.sessionId)?.limits ?? open.budget.limits,
      phase: open.phase, stateVersion: view.sequence, callbackIds: [] }
    return open.openingMode === 'prefill' && open.phase === 'active'
      ? { status: 'prefilled', draft: open.frozenOpening?.text ?? input.opening.text, ...window }
      : { status: 'opened', ...window }
  }
  const pending = result.queueItemId ? view.pending.get(result.queueItemId) : undefined
  if (pending) return { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
    reason: pending.reason, blockedBy: pending.blockedBy }
  const effects = view.decisions.flatMap(decision => decision.effects)
  const cancelled = effects.findIndex(effect => effect.kind === 'queue/cancelled'
    && effect.data.pending.queueItemId === result.queueItemId)
  const refusal = effects[cancelled - 1]
  if (refusal?.kind === 'open/rejected' && refusal.seat === request.seat) return { status: 'rejected', error: refusal.data.error }
  return rejected('state-conflict', 'Opening no longer owns a queue or window')
}
