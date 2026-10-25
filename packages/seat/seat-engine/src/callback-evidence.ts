/** Routed callbacks retain execution evidence before their first durable publication. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import { digest } from './journal.ts'

/** Model readers are execution-local and never resolve source-owner Sessions. */
export type ExecutionModelReader = (sessionId: T.SeatCallbackPayload['sessionId']) => Promise<T.SeatExecutionModelEvidence>

/** Bind callbacks to their original accepted route and immutable model observation.
 * @param view - Recovered journal facts.
 * @param deliveries - Newly constructed callbacks.
 * @param read - Optional local reader; absence freezes missing evidence.
 * @returns Deliveries ready for the original atomic callback publication.
 */
export async function freezeCallbackEvidence(view: EngineProjection, deliveries: readonly T.SeatCallbackDelivery[],
  read?: ExecutionModelReader): Promise<T.SeatCallbackDelivery[]> {
  return Promise.all(deliveries.map(async (delivery) => {
    const payload = delivery.payload
    const retained = view.callbacks.get(payload.callbackId)
    if (retained) return retained
    const accepted = view.authorizationDecisions.flatMap(frame => frame.effects).find(effect =>
      effect.kind === 'node-route/accepted' && view.decisions.some(frame => frame.effects.some(intent =>
        (intent.kind === 'trigger/accepted' || intent.kind === 'trigger/coalesced')
        && intent.data.trigger.sourceId === payload.sourceId && intent.data.trigger.triggerId === payload.triggerId
        && intent.data.pending.frozenOpen?.nodeWorkChain?.authorizationRef === effect.data.authorizationRef)))
    if (accepted?.kind !== 'node-route/accepted') return delivery
    let modelEvidence: T.SeatExecutionModelEvidence = { status: 'missing', sessionId: payload.sessionId,
      nodeId: payload.nodeId, observedAt: new Date().toISOString() }
    if (read) {
      try {
        const evidence = await read(payload.sessionId)
        if (evidence.nodeId === payload.nodeId && evidence.sessionId === payload.sessionId) modelEvidence = structuredClone(evidence)
      } catch (_error) { /* Missing evidence is frozen without preventing callback delivery. */ }
    }
    const body = { callback: payload, route: accepted.data.route, modelEvidence }
    return { ...delivery, nodeWorkChain: structuredClone({ ...body, payloadDigest: digest(body) }) }
  }))
}
