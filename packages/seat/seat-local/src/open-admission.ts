/** Local manual ingress uses the engine queue and never reserves resources independently. */
import type * as T from '@panedesk/dsh-seat'
import { LocalEngineState } from './engine-state.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'
import { z } from 'zod'

const json: z.ZodType<T.SeatJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json),
]))

/** Stable source identity shared by local authenticated opening requests. */
export const localSourceId = 'seat-local-manual' as T.SeatSourceId

/** Submit frozen input through the engine's public ingress and project its retained identity.
 * @param engine - current node engine.
 * @param state - complete engine journal reader.
 * @param input - authenticated opening request and frozen definition.
 * @param nodeName - configured display alias.
 * @returns durable queue or created window, without claiming first-turn completion.
 */
export async function admitLocalOpen(engine: T.SeatEngineService, state: LocalEngineState,
  input: T.SeatLocalOpenRequest, nodeName: string): Promise<T.OpenSeatResult> {
  if (engine.openWindow) return engine.openWindow(input)
  const { request, definition } = input
  if (request.origin === 'engine') return rejected('invalid-request',
    'Engine openings require their registered trigger source.', 'Submit the original automatic trigger.')
  if (request.openingMode === 'prefill') return rejected('unavailable',
    'This engine does not support durable prefill admission.', 'Use automatic opening or install prefill admission.')
  const triggerId = digest(request.operationId) as string as T.TriggerId
  const data = json.parse(JSON.parse(JSON.stringify({ request, opening: input.opening, title: input.title, definition })))
  const result = await engine.accept({ triggerId, sourceId: localSourceId, eventId: triggerId as string as T.SourceEventId,
    kind: 'manual', evidence: { kind: 'manual', origin: request.origin, operationId: request.operationId },
    seat: request.seat, projectId: definition.projectId, receivedAt: new Date().toISOString(), data, dataDigest: digest(data),
    callbackRef: localSourceId, ...(request.taskId === undefined ? {} : { taskId: request.taskId }) })
  if (result.status === 'rejected') return result
  await engine.drive()
  const snapshot = await state.read()
  const opened = snapshot.effects.findLast(effect => (effect.kind === 'open/created' || effect.kind === 'open/configured')
    && effect.data.sources?.some(source => source.triggerId === triggerId))
  if (opened?.kind === 'open/created' || opened?.kind === 'open/configured') return { status: 'opened',
    sessionId: opened.data.sessionId, seat: request.seat, nodeId: input.authority.nodeId, nodeName,
    title: opened.data.title ?? input.title, budget: opened.data.budget.limits, phase: opened.data.phase,
    stateVersion: snapshot.watermark, callbackIds: [] }
  let pending: T.PendingSeatItem | undefined
  for (const [index, effect] of snapshot.effects.entries()) {
    if ((effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced')
      && effect.data.pending.queueItemId === result.queueItemId) pending = effect.data.pending
    if (effect.kind === 'queue/pending' && effect.data.queueItemId === result.queueItemId) pending = effect.data
    if (effect.kind === 'queue/cancelled' && effect.data.pending.queueItemId === result.queueItemId) {
      const refusal = snapshot.effects[index - 1]
      if (refusal?.kind === 'open/rejected' && refusal.seat === request.seat) return { status: 'rejected', error: refusal.data.error }
      pending = undefined
    }
  }
  if (!pending) return rejected('state-conflict', 'Opening queue no longer owns this request.', 'Read the retained window or queue outcome.')
  return { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
    reason: pending.reason, blockedBy: pending.blockedBy }
}
