/** Action dispatch shares the Host timer and serial management queue. */
import type { Context } from '@panedesk/cordis'
import type { Domain } from '@panedesk/dsh-storage-domain'
import { isRecurringScheduleRecord, resolveRecurringOccurrence } from './domain.ts'
import { scheduleActionsDomain, scheduleActionTaskSchema } from './action-storage.ts'
import type { ScheduleActionTask } from './action-storage.ts'
import type { ScheduleActionHandler, ScheduleActionRequest, ScheduleId } from './types.ts'

/** Owns reversible handlers and lazily opened action storage. */
export class ScheduleActions {
  private readonly handlers = new Map<string, ScheduleActionHandler>()
  private domain: Promise<Domain<typeof scheduleActionsDomain>> | undefined

  constructor(private readonly ctx: Context, private readonly retryMs: number) {}

  /**
   * Register a handler whose lifetime follows the caller scope.
   * @param id - Installed action name.
   * @param handler - Durable acceptor; must not await downstream execution.
   * @param changed - Requests the shared Host timer to recompute.
   * @param registrar - Caller scope owning handler removal on reload.
   * @returns Effect-owned unregister operation.
   */
  register(id: string, handler: ScheduleActionHandler, changed: () => void, registrar: Context): () => Promise<void> {
    return registrar.effect(() => {
      if (this.handlers.has(id)) throw new Error(`Schedule action already registered: ${id}`)
      this.handlers.set(id, handler)
      changed()
      return () => { this.handlers.delete(id); changed() }
    })
  }

  /**
   * Persist an action without starting its downstream work.
   * @param request - Existing recurrence record plus opaque JSON action data.
   * @returns Persisted active task; duplicate identities reject without overwriting.
   */
  async create(request: ScheduleActionRequest): Promise<ScheduleActionTask> {
    const task = scheduleActionTaskSchema.parse({ ...request, status: 'active' })
    const tasks = (await this.open()).table('tasks')
    if (tasks.get(task.record.id) !== undefined) throw new Error('Schedule action identity already exists')
    await tasks.put(task.record.id, task)
    return task
  }

  /**
   * Read stored actions without activating their Sessions.
   * @returns Stored tasks and live handler availability without activating Sessions.
   */
  async list(): Promise<(ScheduleActionTask & { available: boolean })[]> {
    return [...(await this.open()).table('tasks').entries()].map(([, task]) => ({
      ...task, available: this.handlers.has(task.actionId),
    }))
  }

  /**
   * Delete the stored task without cancelling accepted downstream work.
   * @param id - Exact task identity.
   * @returns Whether a stored action was deleted.
   */
  async delete(id: ScheduleId): Promise<boolean> {
    const tasks = (await this.open()).table('tasks')
    if (tasks.get(id) === undefined) return false
    await tasks.delete(id)
    return true
  }

  /**
   * Dispatch due actions through the shared Host timer.
   * @param stopping - Disposal observed between durable operations.
   * @returns Nearest action obligation for the existing Host timer.
   */
  drive(stopping: () => boolean): Promise<number | undefined> | undefined {
    if (this.domain === undefined && this.handlers.size === 0) return undefined
    return this.driveStored(stopping)
  }

  private async driveStored(stopping: () => boolean): Promise<number | undefined> {
    const tasks = (await this.open()).table('tasks')
    let next: number | undefined
    for (const [, original] of tasks.entries()) {
      if (stopping()) return undefined
      if (original.status !== 'active') continue
      const handler = this.handlers.get(original.actionId)
      if (handler === undefined) continue
      const target = Date.parse(original.record.scheduledAt)
      let obligation = target
      if (target <= Date.now()) {
        try {
          let task = original
          if (task.pending === undefined) {
            const occurrence = isRecurringScheduleRecord(task.record)
              ? resolveRecurringOccurrence(task.record, Date.now())
              : { occurrenceAt: task.record.scheduledAt, nextScheduledAt: undefined }
            task = { ...task, pending: {
              eventId: `${task.record.id}:${occurrence.occurrenceAt}`,
              scheduledAt: occurrence.occurrenceAt,
              ...(occurrence.nextScheduledAt === undefined ? {} : { nextScheduledAt: occurrence.nextScheduledAt }),
            } }
            await tasks.put(task.record.id, task)
          }
          if (stopping()) return undefined
          const pending = task.pending
          if (pending === undefined) throw new Error('Schedule action occurrence was not frozen')
          const receipt = await handler({
            record: task.record, actionId: task.actionId, payload: task.payload,
            eventId: pending.eventId, scheduledAt: pending.scheduledAt,
          })
          const { pending: _pending, ...rest } = task
          await tasks.put(task.record.id, {
            ...rest,
            record: { ...task.record, scheduledAt: pending.nextScheduledAt ?? pending.scheduledAt },
            status: pending.nextScheduledAt === undefined ? 'inactive' : 'active',
            lastReceipt: { eventId: pending.eventId, scheduledAt: pending.scheduledAt, status: receipt.status },
          })
          if (pending.nextScheduledAt === undefined) continue
          obligation = Date.parse(pending.nextScheduledAt)
        } catch (error: unknown) {
          this.ctx.logger.warn(`schedule: action ${original.record.id} was not acknowledged: ${String(error)}`)
          obligation = Date.now() + this.retryMs
        }
      }
      next = next === undefined ? obligation : Math.min(next, obligation)
    }
    return next
  }

  /** Drain is owned by the shared runtime and must precede this close. */
  async close(): Promise<void> {
    await (await this.domain)?.close()
  }

  private open(): Promise<Domain<typeof scheduleActionsDomain>> {
    this.domain ??= this.ctx.storageDomain.open(scheduleActionsDomain)
    return this.domain
  }
}
