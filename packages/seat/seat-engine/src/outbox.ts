/** At-least-once callbacks retain their original identities and per-source window ordering. */
import type { SeatEngineConfig, SeatCallbackDelivery } from '@panedesk/dsh-seat'
import { EngineJournal, EngineError } from './journal.ts'
import { SourceRegistry } from './sources.ts'
import { fact } from './triggers.ts'

/** One delivery controller owns all in-flight callbacks until they settle. */
export class CallbackOutbox {
  private running: Promise<void> | undefined
  constructor(private readonly journal: EngineJournal, private readonly sources: SourceRegistry,
    private readonly config: SeatEngineConfig) {}

  /** Deliver currently due facts without overtaking a failed earlier state.
   * @param now - host time used for this attempt batch.
   * @returns settlement of all started callbacks; failures remain durable retries.
   */
  deliver(now = Date.now()): Promise<void> {
    if (this.running) return this.running
    this.running = this.run(now).finally(() => { this.running = undefined })
    return this.running
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
        await this.sources.use(delivery.payload.sourceId, source => source.callback(delivery.payload))
        if (performance.now() - started > this.config.callbackTimeoutMs) responseClass = 'transient'
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
