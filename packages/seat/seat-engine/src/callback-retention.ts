/** Callback retry windows are rebuilt from committed history without another durable store. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import { digest } from './journal.ts'

/** One completed transient segment, excluding unincremented sending barriers. */
export interface CallbackRetention {
  since?: number
  latest?: T.SeatCallbackDiagnostic
  attempt: number
  parkedAt?: number
}
/** Fold all callback histories once for one delivery batch.
 * @param decisions - Committed decisions in journal order.
 * @returns Current segment and last completed attempt for each callback.
 */
export function callbackRetentions(decisions: readonly T.EngineDecision[]): Map<T.CallbackId, CallbackRetention> {
  const result = new Map<T.CallbackId, CallbackRetention>()
  for (const decision of decisions) for (const effect of decision.effects) {
    if (effect.kind !== 'callback/pending' && effect.kind !== 'callback/attempted' && effect.kind !== 'callback/delivered') continue
    const delivery = effect.data, id = delivery.payload.callbackId
    const previous = result.get(id) ?? { attempt: 0 }
    const code = delivery.lastDiagnostic?.cause.code
    if (effect.kind === 'callback/attempted' && delivery.responseClass === 'unknown'
      && delivery.attempt === previous.attempt && delivery.nodeWorkChain) continue
    const at = Date.parse(decision.observedAt)
    if (code === 'callback-manually-resumed' || code === 'callback-auto-resumed-on-link-ready') {
      result.set(id, { attempt: delivery.attempt, since: at })
    } else if (delivery.phase === 'paused' || delivery.phase === 'abandoned') {
      result.set(id, { attempt: delivery.attempt, parkedAt: at })
    } else if (effect.kind === 'callback/attempted' && delivery.responseClass === 'transient') {
      result.set(id, { attempt: delivery.attempt, since: previous.since ?? at,
        ...(delivery.lastDiagnostic ? { latest: delivery.lastDiagnostic } : {}) })
    } else result.set(id, { attempt: delivery.attempt })
  }
  return result
}
/** Identify local transport failures without treating source or owner failures as disconnections.
 * @param delivery - Original route, absent for local source delivery.
 * @param diagnostic - Last completed transient observation.
 * @returns Whether the failure came from the remote transport or hello availability check.
 */
export function callbackLinkFailure(delivery: T.SeatCallbackDelivery, diagnostic?: T.SeatCallbackDiagnostic): boolean {
  const route = delivery.nodeWorkChain?.route, cause = diagnostic?.cause
  if (!route || route.sourceOwnerNodeId === delivery.payload.nodeId || !cause || cause.effectState !== 'none') return false
  return cause.domain === 'seat-callback' && cause.reasonCode === 'hello-policy-not-ready'
    || cause.domain === 'node-link' && (
      cause.code === 'node-tunnel-disconnected' && cause.reasonCode === 'tunnel-disconnected'
    || cause.code === 'node-deadline-exceeded' && cause.reasonCode === 'deadline-exceeded'
    || cause.code === 'cross-node-unsupported' && cause.reasonCode === 'peer-capability-missing')
}
/** Attach only fixed safe categories and an existing or deterministically derived correlation ID.
 * @param view - Current committed opening identities.
 * @param delivery - Unchanged callback identity and route.
 * @param code - Fixed category owned by callback delivery.
 * @param stage - Last known local delivery stage.
 * @param retryable - Whether automatic delivery remains permitted.
 * @returns Bounded diagnostic; no exception text is retained.
 */
export function callbackDiagnostic(view: EngineProjection, delivery: T.SeatCallbackDelivery, code: string,
  stage: T.SeatCallbackFailureStage = 'retained', retryable = false): T.SeatCallbackDiagnostic {
  const open = delivery.payload.sessionId ? view.opens.get(delivery.payload.sessionId) : undefined
  const operationId = delivery.nodeWorkChain?.route.originalOperationId ?? open?.openingOperationId
    ?? `callback/${digest(delivery.payload.callbackId)}` as T.SeatOperationId
  return { stage, cause: { domain: 'seat-callback', code, reason: 'Callback delivery requires resolution',
    effectState: 'unknown', retryable, operationId, nodeId: delivery.payload.nodeId } }
}
/** Preserve the callback payload, digest and business key across a parked-state transition.
 * @param view - Current journal projection.
 * @param delivery - Exact state being transitioned.
 * @param action - Resume or abandon the parked callback.
 * @param now - Wall-clock time used by the next delivery batch.
 * @param automatic - Whether a newly observed link readiness caused the resume.
 * @returns An unchanged-attempt state transition for the existing attempted event.
 */
export function resolvedCallback(view: EngineProjection, delivery: T.SeatCallbackDelivery,
  action: 'resume' | 'abandon', now: number, automatic = false): T.SeatCallbackDelivery {
  return { ...delivery, phase: action === 'resume' ? 'retry-due' : 'abandoned',
    nextDue: action === 'resume' ? new Date(now).toISOString() : null,
    responseClass: action === 'resume' ? 'transient' : delivery.responseClass,
    lastDiagnostic: callbackDiagnostic(view, delivery, automatic ? 'callback-auto-resumed-on-link-ready'
      : action === 'resume' ? 'callback-manually-resumed' : 'callback-manually-abandoned', 'retained', action === 'resume') }
}
