/** At-least-once callbacks retain their original identities and per-source window ordering. */
import type { SeatEngineConfig, SeatCallbackDelivery, SeatCallbackDiagnostic, DeliverSourceCallbackRequest } from '@panedesk/dsh-seat'
import { callbackFailure, callbackObservation, type CallbackAttempt } from './routed-callback-types.ts'
import { EngineJournal, EngineError } from './journal.ts'
import { callbackEvidenceMatches } from './callback-evidence.ts'
import { SourceRegistry } from './sources.ts'
import { fact } from './triggers.ts'

/** One delivery controller owns all in-flight callbacks until they settle. */
export class CallbackOutbox {
  private running: Promise<void> | undefined
  constructor(private readonly journal: EngineJournal, private readonly sources: SourceRegistry,
    private readonly config: SeatEngineConfig,
    private readonly routed?: (request: DeliverSourceCallbackRequest) => Promise<CallbackAttempt>) {}

  /** Deliver currently due facts without overtaking a failed earlier state.
   * @param now - host time used for this attempt batch.
   * @returns settlement of all started callbacks; failures remain durable retries.
   */
  deliver(now = Date.now()): Promise<void> {
    if (this.running) return this.running
    this.running = this.run(now).finally(() => { this.running = undefined })
    return this.running
  }
  /** Drain owned callbacks and their durable acknowledgements before closing the journal. */
  async close(): Promise<void> { await this.running }

  private async deliverRouted(request: DeliverSourceCallbackRequest): Promise<{
    responseClass: SeatCallbackDelivery['responseClass']
    diagnostic?: SeatCallbackDiagnostic
  }> {
    const attempt = callbackObservation(request, this.routed ? await this.routed(structuredClone(request))
      : callbackFailure(request, 'retained', 'Callback sender is unavailable'), 'retained')
    const result = attempt.result, diagnostic = attempt.diagnostic
    let responseClass: SeatCallbackDelivery['responseClass']
    if (result.status === 'rejected') responseClass = result.error.effectState === 'unknown' ? 'unknown' : this.refusalClass(result.error)
    else if (result.callbackId !== request.callback.callbackId || result.payloadDigest !== request.payloadDigest) {
      return { responseClass: 'protocol', diagnostic: callbackFailure(request, 'retained', 'Callback receipt did not match',
        'callback-protocol-error', 'none', 'operation-payload-conflict').diagnostic }
    } else if (result.status === 'paused') responseClass = this.refusalClass(result.error) === 'authentication' ? 'authentication' : 'protocol'
    else responseClass = result.status === 'committed' ? 'success' : 'transient'
    if (diagnostic?.cause.reasonCode === 'invalid-diagnostic') responseClass = responseClass === 'unknown'
      || diagnostic.cause.effectState === 'unknown' ? 'unknown' : 'protocol'
    return { responseClass, ...(diagnostic ? { diagnostic } : {}) }
  }

  private refusalClass(error: import('@panedesk/dsh-seat').SeatFailure): SeatCallbackDelivery['responseClass'] {
    const code = error.cause?.code ?? error.code
    return ['node-authentication-failed', 'node-delegation-rejected', 'unauthorized', 'callback-authentication-failed'].includes(code)
      ? 'authentication' : ['node-protocol-mismatch', 'node-operation-conflict', 'operation-id-conflict', 'callback-protocol-error'].includes(code)
        ? 'protocol' : 'transient'
  }

  private async run(now: number): Promise<void> {
    const blocked = new Set<string>()
    const deliveries = [...this.journal.projection.callbacks.values()].sort((a, b) => a.payload.stateVersion - b.payload.stateVersion)
    for (const delivery of deliveries) {
      const key = JSON.stringify([delivery.payload.sourceId, delivery.payload.sessionId, delivery.payload.triggerId])
      if (delivery.phase === 'delivered') continue
      if (blocked.has(key)) continue
      blocked.add(key)
      if (delivery.phase === 'paused' || (delivery.nextDue !== null && Date.parse(delivery.nextDue) > now)) continue
      let responseClass: SeatCallbackDelivery['responseClass'] = 'success'
      let diagnostic: SeatCallbackDiagnostic | undefined
      const started = performance.now()
      try {
        // A timeout cannot cancel arbitrary adapter code; retain ownership until it settles.
        if (delivery.nodeWorkChain) {
          if (!callbackEvidenceMatches(delivery)) {
            responseClass = 'protocol'
            diagnostic = callbackFailure(delivery.nodeWorkChain, 'retained', 'Frozen callback evidence did not match',
              'callback-protocol-error', 'none', 'evidence-digest-mismatch').diagnostic
          } else ({ responseClass, diagnostic } = await this.deliverRouted(delivery.nodeWorkChain))
        } else await this.sources.use(delivery.payload.sourceId, source => source.callback(delivery.payload))
        if (!delivery.nodeWorkChain && responseClass === 'success'
          && performance.now() - started > this.config.callbackTimeoutMs) responseClass = 'transient'
      } catch (error) {
        responseClass = error instanceof EngineError && error.code === 'callback-authentication-failed' ? 'authentication'
          : error instanceof EngineError && error.code === 'callback-protocol-error' ? 'protocol' : 'transient'
        if (delivery.nodeWorkChain) {
          if (error instanceof EngineError && ['source-payload-too-large', 'engine-store-corrupt', 'unavailable'].includes(error.code)) throw error
          if (this.journal.projection.callbacks.get(delivery.payload.callbackId)?.responseClass === 'unknown') responseClass = 'unknown'
          diagnostic = callbackFailure(delivery.nodeWorkChain, 'retained', 'Callback attempt did not complete', 'unavailable',
            responseClass === 'unknown' ? 'unknown' : 'none').diagnostic
        }
      }
      if (delivery.nodeWorkChain && responseClass === 'transient'
        && delivery.responseClass === 'unknown') responseClass = 'unknown'
      const attempt = delivery.attempt + 1
      const phase = responseClass === 'success' ? 'delivered' : responseClass === 'authentication' || responseClass === 'protocol' ? 'paused' : 'retry-due'
      const { lastDiagnostic: _previousDiagnostic, ...original } = delivery
      const updated: SeatCallbackDelivery = { ...original, attempt, responseClass, phase,
        ...(responseClass !== 'success' && diagnostic ? { lastDiagnostic: diagnostic } : {}),
        nextDue: phase === 'retry-due' ? new Date(now + Math.min(this.config.callbackRetryMaxMs,
          this.config.callbackRetryInitialMs * 2 ** Math.min(attempt - 1, 30))).toISOString() : null }
      await this.journal.commit(view => view.callbacks.get(delivery.payload.callbackId)?.phase === 'delivered' ? []
        : [fact({ kind: phase === 'delivered' ? 'callback/delivered' : 'callback/attempted',
          ...(delivery.payload.sessionId ? { sessionId: delivery.payload.sessionId } : {}), data: updated })])
      if (phase === 'delivered') blocked.delete(key)
    }
  }
}
