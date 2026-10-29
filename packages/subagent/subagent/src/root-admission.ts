/** Root-only FIFO admission over the manager's original capacity pool.
 * @module @panedesk/dsh-subagent/root-admission
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { brandString } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import { delegationDepthOf } from './depth.ts'
import { SubagentError } from './error.ts'
import { SubagentQueuedError } from './manager.ts'
import type { SubagentActivation, SubagentActivationSpec, SubagentAdmission, SubagentAdmissionControl, SubagentQueued, SubagentReservation } from './types.ts'

/** Process-local queue transitions; no run identity exists before dequeue. */
export interface SubagentQueueEvent {
  readonly ticketId: SubagentQueued['ticketId']
  readonly parentSessionId: SessionId
  readonly queuedAt: number
  readonly position: number
  readonly state: 'queued' | 'dequeued' | 'cancelled'
  readonly reason?: string
}

declare module '@panedesk/cordis' {
  interface Events {
    /** Observe root admission without implying execution has started.
     * @param event - queued, dequeued, or cancelled ticket transition.
     * @mode emit
     */
    'subagent/queue'(event: SubagentQueueEvent): void
  }
}

interface Entry {
  readonly spec: SubagentActivationSpec
  readonly control: SubagentAdmissionControl
  readonly ticket: SubagentQueued & { position: number; queuedAt: number }
  readonly outcome: PromiseWithResolvers<SubagentActivation | SubagentQueued | { status: 'cancelled'; reason: string }>
  readonly removeAbort: () => void
}

/** Optional provider that composes with, rather than replaces, an installed admission service. */
export class RootSubagentAdmission implements SubagentAdmission {
  private readonly queues = new Map<Agent, Entry[]>()
  private readonly grants = new Map<SubagentActivationSpec, () => void>()
  private readonly pumping = new Set<Agent>()

  constructor(private readonly ctx: Context, private readonly downstream: () => SubagentAdmission | undefined) {
    ctx.on('agent/ending', ({ agent }) => { this.cancelParent(agent, 'session-ended') })
    ctx.on('agent/disposed', ({ agent }) => { this.cancelParent(agent, 'session-ended') })
    ctx.on('agent/turn-admitting', ({ agent, signal }, next) => {
      const cancel = () => { this.cancelParent(agent, 'parent-interrupted') }
      signal.addEventListener('abort', cancel, { once: true })
      const off = agent.ctx.on('agent/turn-stopping', () => {
        signal.removeEventListener('abort', cancel)
        off()
      })
      return next()
    })
    ctx.effect(() => () => {
      for (const parent of this.queues.keys()) this.cancelParent(parent, 'runtime-stopped')
    })
  }

  async acquire(spec: SubagentActivationSpec, control?: SubagentAdmissionControl): Promise<SubagentReservation | SubagentQueued> {
    if (control === undefined) throw new Error('Root queue admission requires manager capacity callbacks')
    spec.signal.throwIfAborted()
    const parent = spec.request.parent
    const root = delegationDepthOf(parent) === 0
    let releaseSlot = this.grants.get(spec)
    this.grants.delete(spec)
    if (releaseSlot === undefined) {
      if (root && (this.queues.get(parent)?.length ?? 0) > 0) return this.enqueue(spec, control)
      try { releaseSlot = control.reserve() }
      catch (error) {
        if (root && error instanceof SubagentError && error.code === 'ACTIVATION_LIMIT_REACHED') return this.enqueue(spec, control)
        throw error
      }
    }
    try {
      const policy = this.downstream()
      const reservation = policy === undefined ? undefined : await policy.acquire(spec, control)
      if (reservation?.status === 'queued') {
        releaseSlot()
        return reservation
      }
      return { status: 'reserved', releaseSlot, release: async (childId) => { await reservation?.release(childId) } }
    } catch (error) {
      releaseSlot()
      throw error
    }
  }

  async continue(parent: Agent, childId: SessionId): Promise<void> {
    await this.downstream()?.continue(parent, childId)
  }

  async resume(parent: Agent, childId: SessionId): Promise<SubagentReservation | SubagentQueued> {
    return await this.downstream()?.resume(parent, childId) ?? { status: 'reserved', release: async () => {} }
  }

  /** Observe original pool release without awaiting a queued child's execution.
   * @param parent - root whose pool can now admit work.
   */
  released(parent: Agent): void {
    if (this.pumping.has(parent)) return
    this.pumping.add(parent)
    try {
      const queue = this.queues.get(parent)
      while (queue !== undefined && queue.length > 0) {
        const entry = queue[0]
        if (entry === undefined) break
        let release: () => void
        try { release = entry.control.reserve() }
        catch (error) {
          if (error instanceof SubagentError && error.code === 'ACTIVATION_LIMIT_REACHED') return
          this.cancel(entry, 'admission-unavailable')
          continue
        }
        queue.shift()
        entry.removeAbort()
        this.grants.set(entry.spec, release)
        this.record(entry, 'dequeued')
        void entry.control.start(entry.spec).then(entry.outcome.resolve, (error: unknown) => {
          this.grants.delete(entry.spec)
          release()
          if (error instanceof SubagentQueuedError) {
            entry.outcome.resolve(error.ticket)
            return
          }
          this.record(entry, 'cancelled', 'startup-failed')
          entry.outcome.resolve({ status: 'cancelled', reason: 'startup-failed' })
        })
      }
      if (queue?.length === 0) this.queues.delete(parent)
    } finally { this.pumping.delete(parent) }
  }

  /** Cancel all unpublished tickets owned by an exact parent.
   * @param parent - exact live parent entering cancellation or teardown.
   * @param reason - safe cancellation classification.
   */
  cancelParent(parent: Agent, reason: string): void {
    for (const entry of [...this.queues.get(parent) ?? []]) this.cancel(entry, reason)
  }

  /** Read queue statistics without creating or restoring children.
   * @param parentSessionId - owning root session.
   * @returns queued count, oldest acceptance time, and current ticket positions.
   */
  list(parentSessionId: SessionId): { queuedCount: number; earliestQueuedAt?: number; tickets: SubagentQueueEvent[] } {
    const entries = [...this.queues].filter(([parent]) => parent.id === parentSessionId).flatMap(([, queue]) => queue)
    return { queuedCount: entries.length,
      ...entries[0] === undefined ? {} : { earliestQueuedAt: entries[0].ticket.queuedAt },
      tickets: entries.map((entry, index) => ({ ticketId: entry.ticket.ticketId, parentSessionId,
        queuedAt: entry.ticket.queuedAt, position: index + 1, state: 'queued' })) }
  }

  private enqueue(spec: SubagentActivationSpec, control: SubagentAdmissionControl): SubagentQueued {
    const parent = spec.request.parent
    const queue = this.queues.get(parent) ?? []
    const outcome = Promise.withResolvers<SubagentActivation | SubagentQueued | { status: 'cancelled'; reason: string }>()
    const cancel = () => { this.cancel(entry, 'caller-cancelled') }
    const ticket = { status: 'queued' as const, ticketId: brandString<SubagentQueued['ticketId']>(randomUUID()),
      parentSessionId: parent.id, position: queue.length + 1, queuedAt: Date.now(), cancel, outcome: outcome.promise }
    const entry: Entry = { spec: { ...spec }, control, ticket, outcome,
      removeAbort: () => { spec.signal.removeEventListener('abort', cancel) } }
    queue.push(entry)
    this.queues.set(parent, queue)
    spec.signal.addEventListener('abort', cancel, { once: true })
    this.record(entry, 'queued')
    return ticket
  }

  private cancel(entry: Entry, reason: string): void {
    const queue = this.queues.get(entry.spec.request.parent)
    const index = queue?.indexOf(entry) ?? -1
    if (queue === undefined || index < 0) return
    queue.splice(index, 1)
    entry.removeAbort()
    entry.outcome.resolve({ status: 'cancelled', reason })
    if (queue.length === 0) this.queues.delete(entry.spec.request.parent)
    this.record(entry, 'cancelled', reason)
  }

  private record(entry: Entry, state: SubagentQueueEvent['state'], reason?: string): void {
    const { ticketId, parentSessionId, position, queuedAt } = entry.ticket
    const event: SubagentQueueEvent = { ticketId, parentSessionId, position, queuedAt, state,
      ...reason === undefined ? {} : { reason } }
    for (const callback of this.ctx.events.dispatch('emit', ['subagent/queue', event])) {
      try {
        const returned: unknown = callback(event)
        void Promise.resolve(returned).catch(() => { this.ctx.logger.warn('subagent queue observer rejected') })
      } catch (_error) { this.ctx.logger.warn('subagent queue observer threw') }
    }
  }
}
