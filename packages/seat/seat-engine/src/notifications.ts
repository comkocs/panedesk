/** Durable completion ownership is independent of the live producer and its plugin fiber. */
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { JobNotifications } from '@panedesk/dsh-jobs'
import type { SubagentNotifications } from '@panedesk/dsh-subagent'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type { SeatEngine } from './engine.ts'
import type { OwnerEpoch, WaitObject } from '@panedesk/dsh-seat'
import { fact } from './triggers.ts'
import { digest, EngineError } from './journal.ts'
import { NotificationStore, type NotificationRecord } from './notification-store.ts'

/** Installs synchronous job writers and a stable-identity durable message outbox. */
export class CompletionProviders {
  private readonly store: NotificationStore
  private active: Promise<void> | undefined
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly ctx: Context, private readonly engine: SeatEngine) {
    this.store = new NotificationStore(join(engine.journal.root, 'notifications'), engine.options.config.maxDecisionBytes)
  }
  /** Execution-bound job writers persist intent before work and retain settlement for delivery. */
  readonly jobs: JobNotifications = {
    prepare: (intent) => {
      if (this.stopped) throw new EngineError('unavailable', 'Notification provider is stopping')
      const id = `job:${intent.jobId}`
      const initial: NotificationRecord = { version: 1, id, owner: intent.owner ?? null, phase: 'intent',
        outcome: 'unknown', text: `Job ${intent.jobId}: ${intent.label}`, delivered: false,
        observedAt: new Date(intent.startedAt).toISOString() }
      if (this.store.records.has(id)) throw new EngineError('operation-id-conflict', 'Job identity already exists')
      this.store.put(initial)
      return {
        running: () => {
          if (this.stopped) throw new EngineError('unavailable', 'Notification writer lost its engine owner')
          this.store.put({ ...initial, phase: 'running' })
        },
        settled: (observation) => {
          if (this.stopped) throw new EngineError('unavailable', 'Notification writer lost its engine owner')
          const previous = this.store.records.get(id)
          if (previous?.phase === 'settled') return
          this.store.put({ ...initial, phase: 'settled',
            outcome: observation.outcome.status === 'killed' ? 'cancelled' : observation.outcome.status,
            text: `${initial.text}\n${observation.outcome.status}${observation.outcome.detail ? `: ${observation.outcome.detail}` : ''}`,
            observedAt: new Date(observation.finishedAt).toISOString() })
          this.requestDelivery()
        },
      }
    },
  }
  /** Idempotent subagent settlements retain parent notifications until durable delivery succeeds. */
  readonly subagents: SubagentNotifications = {
    accept: async (request) => {
      if (this.stopped) throw new EngineError('unavailable', 'Notification provider is stopping')
      const id = `subagent:${request.runId}`
      if (!this.store.records.has(id)) this.store.put({ version: 1, id, owner: request.parent.id,
        phase: 'settled', outcome: request.result.stopReason === 'completed' ? 'completed'
          : request.result.stopReason === 'aborted' ? 'cancelled' : 'failed',
        text: request.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        delivered: false, observedAt: new Date().toISOString() })
      await this.deliver()
    },
  }
  /** Begin retries after all providers have been registered. */
  start(): void { this.requestDelivery(); this.schedule() }
  private requestDelivery(): void {
    void this.deliver().catch((error: unknown) => { this.ctx.logger.warn('Seat completion delivery remains pending', error) })
  }
  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => { this.requestDelivery(); this.schedule() }, this.engine.options.config.ownerObserveIntervalMs)
    this.timer.unref()
  }
  private deliver(): Promise<void> {
    if (this.active) return this.active
    this.active = this.run().finally(() => { this.active = undefined })
    return this.active
  }
  private async run(): Promise<void> {
    const delivery = this.ctx.get('messageDelivery')
    if (!delivery || this.stopped) return
    for (const record of this.store.records.values()) {
      if (record.delivered || !['settled', 'owner-lost'].includes(record.phase)) continue
      if (record.owner !== null) {
        const object: WaitObject = record.id.startsWith('job:')
          ? { kind: 'job', id: record.id.slice(4) as Extract<WaitObject, { kind: 'job' }>['id'] }
          : { kind: 'subagent', id: record.id.slice(9) as Extract<WaitObject, { kind: 'subagent' }>['id'] }
        await this.engine.journal.commit(view => view.decisions.some(decision => decision.effects.some(effect =>
          effect.kind === 'job/observed' && effect.data.phase === 'settled'
          && effect.data.observation.object.kind === object.kind && effect.data.observation.object.id === object.id)) ? []
          : [fact({ kind: 'job/observed', data: { sessionId: record.owner as NonNullable<NotificationRecord['owner']>,
            ownerEpoch: digest(record.id) as string as OwnerEpoch, phase: 'settled', observation: { object,
              outcome: record.phase === 'owner-lost' ? 'owner-lost' : record.outcome, watermark: view.sequence + 1,
              observedAt: record.observedAt, durability: 'durable' } } })])
        const result = await delivery.send({ target: { sessionId: record.owner }, content: record.text,
          messageClass: 'handoff', priority: 'steer', operationId: digest(record.id) as string as OperationId })
        if (result.deliveryOutcome !== 'accepted' && result.reason !== 'target-closed-pending') {
          throw new EngineError('unavailable', `Completion delivery refused: ${result.reason}`)
        }
      }
      this.store.put({ ...record, delivered: true })
    }
  }
  /** Stop retries and fence execution-bound writers before releasing the engine lock. */
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.active
  }
}
