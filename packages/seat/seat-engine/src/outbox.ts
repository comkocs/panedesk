/** At-least-once callbacks retain their original identities and per-source window ordering. */
import type { SeatEngineConfig, SeatCallbackDelivery, SeatCallbackDiagnostic, DeliverSourceCallbackRequest } from '@panedesk/dsh-seat'
import { callbackFailure, callbackObservation, type CallbackAttempt } from './routed-callback-types.ts'
import { EngineJournal, EngineError, canonical } from './journal.ts'
import type { FailureObservation } from './failure.ts'
import { callbackEvidenceMatches } from './callback-evidence.ts'
import { SourceRegistry } from './sources.ts'
import { fact } from './triggers.ts'
import { callbackRetentions, callbackLinkFailure, callbackDiagnostic, resolvedCallback } from './callback-retention.ts'

const CALLBACK_TRANSIENT_LIMIT_MS = 900000

/** Identify parked authority refusals whose durable evidence confirms no business effects.
 * @param delivery - Committed callback delivery.
 * @returns Whether operator resolution contains the refusal without an engine failure.
 */
export function isParkedIssuerRefusal(delivery: SeatCallbackDelivery): boolean {
  const diagnostic = delivery.lastDiagnostic
  return delivery.phase === 'paused' && delivery.responseClass === 'authentication'
    && diagnostic?.stage === 'issuer' && diagnostic.cause.code === 'unauthorized'
    && diagnostic.cause.effectState === 'none'
    && (diagnostic.cause.reasonCode === undefined
      || ['evidence-missing', 'evidence-revoked', 'hello-policy-not-ready'].includes(diagnostic.cause.reasonCode))
}

/** Identify only parked authentication refusals with confirmed absent effects.
 * @param delivery - Committed callback evidence.
 * @returns Whether the refusal is contained by manual callback resolution.
 */
export function isParkedAuthenticationRefusal(delivery: SeatCallbackDelivery): boolean {
  return isParkedIssuerRefusal(delivery) || delivery.phase === 'paused' && delivery.responseClass === 'authentication'
    && delivery.lastDiagnostic?.cause.code === 'callback-authentication-failed'
    && delivery.lastDiagnostic.cause.effectState === 'none'
}

/** Recognize source-owned parking without granting permission to replay business effects.
 * @param delivery - Retained original callback and validated owner observation.
 * @returns Whether only exact owner queries may advance this parked callback.
 */
export function isParkedOwnerCallback(delivery: SeatCallbackDelivery): boolean {
  const body = delivery.nodeWorkChain, cause = delivery.lastDiagnostic?.cause
  return delivery.phase === 'paused' && delivery.parkingClass === 'owner-unconfirmed'
    && !!body && callbackEvidenceMatches(delivery) && cause?.operationId === body.route.originalOperationId
    && cause.nodeId === body.route.sourceOwnerNodeId && cause.reasonCode !== 'invalid-diagnostic'
}

/** One delivery controller owns all in-flight callbacks until they settle. */
export class CallbackOutbox {
  private running: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private version = 0
  private readonly buffered = new Map<SeatCallbackDelivery['payload']['callbackId'], {
    base: SeatCallbackDelivery
    delivery: SeatCallbackDelivery
    version: number
  }>()
  constructor(private readonly journal: EngineJournal, private readonly sources: SourceRegistry,
    private readonly config: SeatEngineConfig,
    private readonly routed?: (request: DeliverSourceCallbackRequest, observation?: SeatCallbackDelivery) => Promise<CallbackAttempt>,
    private readonly linkReady?: (delivery: SeatCallbackDelivery, parkedAt: number) => Promise<boolean>,
    private readonly recordFailure?: (cause: unknown, observation?: FailureObservation) => void) {}

  /** Report retained failed deliveries, including attempts not yet due.
   * @returns Whether a failed callback still needs settlement.
   */
  hasFailedDelivery(): boolean {
    return this.observations().some(delivery => delivery.responseClass !== null && !delivery.ownerPending
      && delivery.phase !== 'delivered' && delivery.phase !== 'abandoned'
      && !isParkedAuthenticationRefusal(delivery) && !isParkedOwnerCallback(delivery))
  }

  /** Deliver currently due facts without overtaking a failed earlier state.
   * @param now - host time used for this attempt batch.
   * @returns settlement of all started callbacks; failures remain durable retries.
   */
  deliver(now = Date.now()): Promise<void> {
    if (this.closing) return this.closing
    if (this.running) return this.running
    this.running = this.run(now).finally(() => { this.running = undefined })
    return this.running
  }
  /** Read detached live observations without publishing uncommitted journal state.
   * @returns Committed deliveries overlaid with this controller's valid retry observations.
   */
  observations(): readonly SeatCallbackDelivery[] {
    return [...this.journal.projection.callbacks.values()].map((delivery) => {
      const pending = this.buffered.get(delivery.payload.callbackId)
      return structuredClone(pending?.base === delivery ? pending.delivery : delivery)
    })
  }

  /** Stop admission, drain accepted attempts and fold each remaining observation once. */
  close(): Promise<void> {
    return this.closing ??= this.drain()
  }

  private async drain(): Promise<void> {
    await this.running
    await this.flush()
  }

  /** Fold current observations; concurrent folds compare the captured buffer version.
   * @returns Settlement of the captured observations without stopping admission.
   */
  async flush(): Promise<void> {
    await this.running
    for (const [id, pending] of this.buffered) {
      const committed = await this.journal.commit(view => view.callbacks.get(id) === pending.base
        && this.buffered.get(id)?.version === pending.version
        ? [fact({ kind: 'callback/attempted', data: pending.delivery })] : [])
      const latest = this.buffered.get(id)
      if (latest?.version === pending.version) this.buffered.delete(id)
      else if (committed && latest?.base === pending.base
        && this.journal.projection.callbacks.get(id) === pending.delivery) {
        this.buffered.set(id, { ...latest, base: pending.delivery })
      }
    }
  }

  private async deliverRouted(request: DeliverSourceCallbackRequest, delivery: SeatCallbackDelivery): Promise<{
    responseClass: SeatCallbackDelivery['responseClass']
    diagnostic?: SeatCallbackDiagnostic
    observation?: FailureObservation
    ownerPending?: boolean
    ownerPaused?: boolean
    ownerAbandoned?: boolean
    completedDispatch?: boolean
  }> {
    const routed: CallbackAttempt = this.routed ? await this.routed(structuredClone(request), structuredClone(delivery))
      : callbackFailure(request, 'retained', 'Callback sender is unavailable')
    const attempt = callbackObservation(request, routed, 'retained')
    const result = attempt.result, diagnostic = attempt.diagnostic
    let responseClass: SeatCallbackDelivery['responseClass']
    if (result.status === 'rejected') responseClass = result.error.effectState === 'unknown' ? 'unknown' : this.refusalClass(result.error)
    else if (result.callbackId !== request.callback.callbackId || result.payloadDigest !== request.payloadDigest) {
      return { responseClass: 'protocol', diagnostic: callbackFailure(request, 'retained', 'Callback receipt did not match',
        'callback-protocol-error', 'none', 'operation-payload-conflict').diagnostic }
    } else if (result.status === 'paused') responseClass = this.refusalClass(result.error) === 'authentication' ? 'authentication' : 'protocol'
    else responseClass = result.status === 'committed' ? 'success' : routed.queryOnly ? 'unknown' : 'transient'
    if (diagnostic?.cause.reasonCode === 'invalid-diagnostic') responseClass = responseClass === 'unknown'
      || diagnostic.cause.effectState === 'unknown' ? 'unknown' : 'protocol'
    const error = result.status === 'rejected' || result.status === 'paused' ? result.error : undefined
    const observation: FailureObservation | undefined = diagnostic ? { phase: diagnostic.stage,
      effectState: error?.effectState !== 'none' ? error?.effectState ?? 'unknown' : diagnostic.cause.effectState,
      retryable: error?.retryable === true && diagnostic.cause.retryable,
      ...(diagnostic.cause.reasonCode ? { reasonCode: diagnostic.cause.reasonCode } : {}) } : undefined
    const retainedDiagnostic = responseClass === 'authentication' && diagnostic && observation
      ? { ...diagnostic, cause: { ...diagnostic.cause, effectState: observation.effectState } } : diagnostic
    return { responseClass, ...(retainedDiagnostic ? { diagnostic: retainedDiagnostic } : {}), ...(observation ? { observation } : {}),
      ...(result.status === 'pending' && diagnostic?.cause.reasonCode !== 'invalid-diagnostic' ? { ownerPending: true } : {}),
      ...(result.status === 'paused' && responseClass === 'protocol' && this.refusalClass(result.error) === 'transient' && diagnostic
        && diagnostic.cause.reasonCode !== 'invalid-diagnostic'
        && diagnostic.cause.operationId === request.route.originalOperationId
        && diagnostic.cause.nodeId === request.route.sourceOwnerNodeId
        ? { ownerPaused: true, ownerAbandoned: diagnostic.cause.code === 'callback-manually-abandoned' } : {}),
      ...(routed.completedDispatch ? { completedDispatch: true } : {}) }
  }

  private refusalClass(error: import('@panedesk/dsh-seat').SeatFailure): SeatCallbackDelivery['responseClass'] {
    const code = error.cause?.code ?? error.code
    return ['node-authentication-failed', 'node-delegation-rejected', 'unauthorized', 'callback-authentication-failed'].includes(code)
      ? 'authentication' : ['node-protocol-mismatch', 'node-operation-conflict', 'operation-id-conflict', 'callback-protocol-error'].includes(code)
        ? 'protocol' : 'transient'
  }

  private async run(now: number): Promise<void> {
    const blocked = new Set<string>()
    const retentions = callbackRetentions(this.journal.projection.decisions)
    const deliveries = [...this.journal.projection.callbacks.values()].sort((a, b) => a.payload.stateVersion - b.payload.stateVersion)
    for (let delivery of deliveries) {
      let durable = delivery
      const buffered = this.buffered.get(delivery.payload.callbackId)
      if (buffered?.base === durable) delivery = buffered.delivery
      else this.buffered.delete(delivery.payload.callbackId)
      const key = JSON.stringify([delivery.payload.sourceId, delivery.payload.sessionId, delivery.payload.triggerId])
      if (delivery.phase === 'delivered' || delivery.phase === 'abandoned') { blocked.delete(key); continue }
      if (blocked.has(key)) continue
      blocked.add(key)
      let retention = retentions.get(delivery.payload.callbackId)
      if (buffered?.base === durable && delivery.retrySummary) retention = {
        attempt: delivery.attempt,
        ...(delivery.retrySummary.transientSince ? { since: Date.parse(delivery.retrySummary.transientSince) } : {}),
        ...(delivery.lastDiagnostic ? { latest: delivery.lastDiagnostic } : {}),
      }
      const ownerParked = isParkedOwnerCallback(delivery)
      if (delivery.phase === 'paused' && !ownerParked) {
        if (delivery.lastDiagnostic?.cause.code !== 'callback-link-unreachable-limit'
          || retention?.parkedAt === undefined || !await this.linkReady?.(delivery, retention.parkedAt)) continue
        const parked = delivery
        const resumed = await this.journal.commit((view) => {
          const current = view.callbacks.get(parked.payload.callbackId)
          return current === parked ? [fact({ kind: 'callback/attempted',
            data: resolvedCallback(view, current, 'resume', now, true) })] : []
        })
        if (!resumed) continue
        delivery = this.journal.projection.callbacks.get(delivery.payload.callbackId) as SeatCallbackDelivery
        durable = delivery
        retention = { attempt: delivery.attempt, since: Date.parse(resumed.observedAt) }
      }
      if (delivery.responseClass === 'transient' && !delivery.ownerPending && retention?.since !== undefined
        && now - retention.since >= CALLBACK_TRANSIENT_LIMIT_MS) {
        const parked = delivery
        await this.journal.commit(view => view.callbacks.get(parked.payload.callbackId) !== durable ? []
          : [fact({ kind: 'callback/attempted', data: { ...parked, phase: 'paused', nextDue: null, parkingClass: 'transport-transient',
            lastDiagnostic: callbackDiagnostic(view, parked, callbackLinkFailure(parked, retention.latest)
              ? 'callback-link-unreachable-limit' : 'callback-transient-limit-reached') } })])
        this.buffered.delete(delivery.payload.callbackId)
        continue
      }
      if (delivery.nextDue !== null && Date.parse(delivery.nextDue) > now) continue
      let responseClass: SeatCallbackDelivery['responseClass'] = 'success'
      let diagnostic: SeatCallbackDiagnostic | undefined
      let observation: FailureObservation | undefined
      let ownerPending = false, ownerPaused = false, ownerAbandoned = false, completedDispatch = false
      const started = performance.now()
      let failure: unknown
      const localDispatch = { started: false }
      try {
        // A timeout cannot cancel arbitrary adapter code; retain ownership until it settles.
        if (delivery.nodeWorkChain) {
          if (!callbackEvidenceMatches(delivery)) {
            responseClass = 'protocol'
            diagnostic = callbackFailure(delivery.nodeWorkChain, 'retained', 'Frozen callback evidence did not match',
              'callback-protocol-error', 'none', 'evidence-digest-mismatch').diagnostic
          } else ({ responseClass, diagnostic, observation, ownerPending = false, ownerPaused = false,
            ownerAbandoned = false, completedDispatch = false } = await this.deliverRouted(delivery.nodeWorkChain, delivery))
        } else await this.sources.use(delivery.payload.sourceId, (source) => {
          localDispatch.started = true
          return source.callback(delivery.payload)
        })
        if (!delivery.nodeWorkChain && responseClass === 'success'
          && performance.now() - started > this.config.callbackTimeoutMs) {
          responseClass = 'transient'
          diagnostic = callbackDiagnostic(this.journal.projection, delivery, 'callback-timeout', 'local-dispatch', true)
        }
      } catch (error) {
        failure = error
        if (!delivery.nodeWorkChain && !localDispatch.started && error instanceof EngineError && error.code === 'source-not-found') {
          observation = { phase: 'retained', effectState: 'none', retryable: true }
        }
        responseClass = error instanceof EngineError && error.code === 'callback-authentication-failed' ? 'authentication'
          : error instanceof EngineError && error.code === 'callback-protocol-error' ? 'protocol' : 'transient'
        if (delivery.nodeWorkChain) {
          observation = { phase: 'retained', effectState: 'unknown', retryable: false }
          if (error instanceof EngineError && ['source-payload-too-large', 'engine-store-corrupt', 'unavailable'].includes(error.code)) throw error
          if (this.journal.projection.callbacks.get(delivery.payload.callbackId)?.responseClass === 'unknown') responseClass = 'unknown'
          diagnostic = callbackFailure(delivery.nodeWorkChain, 'retained', 'Callback attempt did not complete', 'unavailable',
            responseClass === 'unknown' ? 'unknown' : 'none').diagnostic
        } else diagnostic = callbackDiagnostic(this.journal.projection, delivery,
          responseClass === 'authentication' ? 'callback-authentication-failed'
            : responseClass === 'protocol' ? 'callback-protocol-error' : 'callback-unclassified-error',
          'local-dispatch', responseClass === 'transient')
        if (!delivery.nodeWorkChain && responseClass === 'authentication') {
          const effect = error !== null && typeof error === 'object' && 'effectState' in error ? error.effectState : undefined
          const effectState = effect === 'none' || effect === 'partial' || effect === 'committed' ? effect : 'unknown'
          observation = { phase: 'local-dispatch', retryable: false, effectState }
        }
        if (!delivery.nodeWorkChain && observation) {
          // A no-effect attempt cannot erase an earlier attempt's uncertain business effects.
          const retained = delivery.lastDiagnostic?.cause.effectState
          if (delivery.attempt > 0 && retained !== 'none') observation.effectState = retained ?? 'unknown'
          diagnostic = { ...diagnostic, stage: observation.phase,
            cause: { ...diagnostic.cause, effectState: observation.effectState } }
        }
      }
      if (delivery.nodeWorkChain && responseClass === 'transient' && !ownerPending
        && delivery.responseClass === 'unknown') responseClass = 'unknown'
      if (ownerParked && ownerPaused && !ownerAbandoned
        && canonical(diagnostic) === canonical(delivery.lastDiagnostic)) continue
      const attempt = delivery.attempt + 1
      const limited = responseClass === 'transient' && !ownerPending && retention?.since !== undefined
        && Date.now() - retention.since >= CALLBACK_TRANSIENT_LIMIT_MS
      const phase = ownerAbandoned ? 'abandoned' : responseClass === 'success' ? 'delivered'
        : limited || responseClass === 'authentication' || responseClass === 'protocol' ? 'paused' : 'retry-due'
      if (limited) diagnostic = callbackDiagnostic(this.journal.projection, delivery,
        callbackLinkFailure(delivery, diagnostic) ? 'callback-link-unreachable-limit' : 'callback-transient-limit-reached')
      const { lastDiagnostic: _previousDiagnostic, ownerPending: _pending, parkingClass: _parking,
        retrySummary: previousSummary, ...original } = delivery
      const at = new Date(now).toISOString(), latestDiagnostic = diagnostic ?? previousSummary?.lastDiagnostic
      const summary = responseClass === 'success' || ownerAbandoned || ownerParked && ownerPaused ? previousSummary
        : ownerPending && !completedDispatch ? {
          ...previousSummary ?? { count: 0, firstAttemptAt: at, lastAttemptAt: at }, transientSince: null,
        } : {
          count: (previousSummary?.count ?? 0) + 1,
          firstAttemptAt: previousSummary?.count ? previousSummary.firstAttemptAt : at, lastAttemptAt: at,
          transientSince: responseClass === 'transient' && !ownerPending
            ? new Date(retention?.since ?? Date.now()).toISOString() : null,
          ...(latestDiagnostic ? { lastDiagnostic: latestDiagnostic } : {}),
          ...(previousSummary?.attemptsAtLeast ? { attemptsAtLeast: true } : {}),
        }
      const updated: SeatCallbackDelivery = { ...original, attempt, responseClass, phase,
        ...(ownerPending ? { ownerPending: true } : {}),
        ...(ownerPaused ? { parkingClass: 'owner-unconfirmed' as const } : limited ? { parkingClass: 'transport-transient' as const } : {}),
        ...(summary ? { retrySummary: summary } : {}),
        ...(responseClass !== 'success' && diagnostic ? { lastDiagnostic: diagnostic } : {}),
        nextDue: phase === 'retry-due' ? new Date(now + Math.min(this.config.callbackRetryMaxMs,
          this.config.callbackRetryInitialMs * 2 ** Math.min(attempt - 1, 30))).toISOString() : null }
      const latest = this.buffered.get(delivery.payload.callbackId)
      if (latest?.delivery === delivery) durable = latest.base
      const base = this.journal.projection.callbacks.get(delivery.payload.callbackId)
      const sendingBarrier = !!delivery.nodeWorkChain && base?.responseClass === 'unknown'
        && base.attempt === durable.attempt && base.phase === durable.phase
      if (phase === 'retry-due' && (delivery.attempt > 0 || sendingBarrier)
        || ownerParked && ownerPaused && !ownerAbandoned) {
        if (base && (base === durable || base === delivery || sendingBarrier)) {
          this.buffered.set(delivery.payload.callbackId, { base, delivery: updated, version: ++this.version })
        }
      } else {
        await this.journal.commit((view) => {
          const current = view.callbacks.get(delivery.payload.callbackId)
          if (!current || current.phase === 'delivered' || current.phase === 'abandoned'
            || current.phase === 'paused' && !(current === durable && isParkedOwnerCallback(current))
            || current.attempt !== durable.attempt && current !== delivery) return []
          return [fact({ kind: phase === 'delivered' ? 'callback/delivered' : 'callback/attempted',
            ...(delivery.payload.sessionId ? { sessionId: delivery.payload.sessionId } : {}), data: updated })]
        })
        this.buffered.delete(delivery.payload.callbackId)
      }
      if (phase === 'delivered' || phase === 'abandoned') blocked.delete(key)
      else if (ownerPaused || ownerPending
        || isParkedAuthenticationRefusal(updated) && (failure === undefined || !delivery.nodeWorkChain)) continue
      else if (this.recordFailure) {
        if (failure !== undefined || diagnostic || responseClass !== 'transient') {
          this.recordFailure(responseClass === 'unknown' ? { code: 'callback-outcome-unconfirmed' }
            : failure ?? { code: diagnostic?.cause.code ?? 'callback-outcome-unconfirmed' },
          observation ? { ...observation, retryable: observation.retryable && phase === 'retry-due',
            effectState: responseClass === 'unknown' ? 'unknown' : observation.effectState } : undefined)
        }
        return
      }
    }
  }
}
