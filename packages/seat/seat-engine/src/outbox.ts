/** At-least-once callbacks retain their original identities and per-source window ordering. */
import type { SeatEngineConfig, SeatCallbackDelivery, DeliverSourceCallbackRequest, DeliverSourceCallbackResult } from '@panedesk/dsh-seat'
import { digest, EngineJournal, EngineError } from './journal.ts'
import { SourceRegistry } from './sources.ts'
import { fact } from './triggers.ts'

/** One delivery controller owns all in-flight callbacks until they settle. */
export class CallbackOutbox {
  private running: Promise<void> | undefined
  constructor(private readonly journal: EngineJournal, private readonly sources: SourceRegistry,
    private readonly config: SeatEngineConfig,
    private readonly routed?: (request: DeliverSourceCallbackRequest) => Promise<DeliverSourceCallbackResult>) {}

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

  private async deliverRouted(request: DeliverSourceCallbackRequest): Promise<SeatCallbackDelivery['responseClass']> {
    if (!this.routed) return 'transient'
    const result = await this.routed(structuredClone(request))
    if (result.status === 'rejected') return result.error.effectState === 'unknown' ? 'unknown' : this.refusalClass(result.error)
    if (result.callbackId !== request.callback.callbackId || result.payloadDigest !== request.payloadDigest) return 'protocol'
    if (result.status === 'paused') {
      return this.refusalClass(result.error) === 'authentication' ? 'authentication' : 'protocol'
    }
    return result.status === 'committed' ? 'success' : 'transient'
  }

  private refusalClass(error: import('@panedesk/dsh-seat').SeatFailure): SeatCallbackDelivery['responseClass'] {
    const code = error.cause?.code ?? error.code
    return ['node-authentication-failed', 'node-delegation-rejected', 'unauthorized', 'callback-authentication-failed'].includes(code)
      ? 'authentication' : ['node-protocol-mismatch', 'node-operation-conflict', 'callback-protocol-error'].includes(code)
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
      const started = performance.now()
      try {
        // A timeout cannot cancel arbitrary adapter code; retain ownership until it settles.
        if (delivery.nodeWorkChain) {
          const { payloadDigest, ...body } = delivery.nodeWorkChain
          responseClass = digest(body) !== payloadDigest || digest(body.callback) !== delivery.payloadDigest
            || digest(delivery.payload) !== delivery.payloadDigest || body.route.targetNodeId !== delivery.payload.nodeId
            || body.route.sourceId !== delivery.payload.sourceId || body.modelEvidence.nodeId !== delivery.payload.nodeId
            || body.modelEvidence.sessionId !== delivery.payload.sessionId ? 'protocol'
            : await this.deliverRouted(delivery.nodeWorkChain)
        } else await this.sources.use(delivery.payload.sourceId, source => source.callback(delivery.payload))
        if (responseClass === 'success' && performance.now() - started > this.config.callbackTimeoutMs) responseClass = 'transient'
      } catch (error) {
        responseClass = error instanceof EngineError && error.code === 'callback-authentication-failed' ? 'authentication'
          : error instanceof EngineError && error.code === 'callback-protocol-error' ? 'protocol' : 'transient'
      }
      const attempt = delivery.attempt + 1
      const phase = responseClass === 'success' ? 'delivered' : responseClass === 'authentication' || responseClass === 'protocol' ? 'paused' : 'retry-due'
      const updated: SeatCallbackDelivery = { ...delivery, attempt, responseClass, phase,
        nextDue: phase === 'retry-due' ? new Date(now + Math.min(this.config.callbackRetryMaxMs,
          this.config.callbackRetryInitialMs * 2 ** Math.min(attempt - 1, 30))).toISOString() : null }
      await this.journal.commit(view => view.callbacks.get(delivery.payload.callbackId)?.phase === 'delivered' ? []
        : [fact({ kind: phase === 'delivered' ? 'callback/delivered' : 'callback/attempted',
          ...(delivery.payload.sessionId ? { sessionId: delivery.payload.sessionId } : {}), data: updated })])
      if (phase === 'delivered') blocked.delete(key)
    }
  }
}
