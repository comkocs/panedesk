/** Session-local queue metadata, independent of the Session event log and ledger.
 * @module @panedesk/dsh-subagent/queue-journal
 */
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Agent } from '@panedesk/dsh-agent'
import type { Context } from '@panedesk/cordis'
import { brandString } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import type { SubagentQueued } from './types.ts'

const recordSchema = z.object({
  ticketId: z.string().min(1), parentSessionId: z.string().min(1),
  agentType: z.string().min(1), position: z.number().int().positive(),
  queuedAt: z.number().int().nonnegative(),
  state: z.enum(['queued', 'dequeued', 'cancelled', 'notified']),
  dequeuedAt: z.number().int().nonnegative().optional(),
  cancelledAt: z.number().int().nonnegative().optional(),
  notifiedAt: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
}).strict().refine((record) => {
  if (record.state === 'queued') return record.dequeuedAt === undefined && record.cancelledAt === undefined
    && record.notifiedAt === undefined && record.reason === undefined
  if (record.state === 'dequeued') return record.dequeuedAt !== undefined && record.cancelledAt === undefined
    && record.notifiedAt === undefined && record.reason === undefined
  return record.cancelledAt !== undefined && record.dequeuedAt === undefined && record.reason !== undefined
    && (record.state === 'notified' ? record.notifiedAt !== undefined : record.notifiedAt === undefined)
})

/** Metadata-only transition; no task, label, model options, or execution identity. */
export interface QueueJournalRecord {
  readonly ticketId: SubagentQueued['ticketId']
  readonly parentSessionId: SessionId
  readonly agentType: string
  readonly position: number
  readonly queuedAt: number
  readonly state: 'queued' | 'dequeued' | 'cancelled' | 'notified'
  readonly dequeuedAt?: number
  readonly cancelledAt?: number
  readonly notifiedAt?: number
  readonly reason?: string
}

/** Queue writers share the live Session's exclusive write lease. Synchronous
 * append/fsync keeps each transition indivisible within that single writer.
 */
export class QueueJournal {
  private readonly directories = new WeakMap<Agent, string>()

  constructor(private readonly ctx: Context) {}

  /** Materialize the owning Session before permitting any sidecar write.
   * @param parent - exact live write owner.
   */
  async prepare(parent: Agent): Promise<void> {
    if (this.directories.has(parent)) return
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence?.sidecarDirectory === undefined) throw new Error('Queue persistence requires session-local files')
    if (!await parent.ctx.sessions.flush(parent.session)) throw new Error('Queue persistence requires a durable parent session')
    const directory = await persistence.sidecarDirectory(parent.id)
    if (directory === undefined) throw new Error('Queue persistence requires a materialized parent session')
    this.directories.set(parent, directory)
  }

  /** Append and synchronize before publishing a transition. Failed writes are
   * uncertain: callers must refuse acceptance or stop the affected dispatch.
   * @param parent - prepared live Session writer.
   * @param record - metadata-only transition.
   */
  append(parent: Agent, record: QueueJournalRecord): void {
    const directory = this.directories.get(parent)
    if (directory === undefined) throw new Error('Queue journal is not prepared')
    const path = join(directory, 'subagent-queue.jsonl')
    const handle = openSync(path, 'a+', 0o600)
    try {
      // Separate a previous torn tail without rewriting any committed bytes.
      const size = fstatSync(handle).size
      const last = Buffer.alloc(1)
      if (size > 0) readSync(handle, last, 0, 1, size - 1)
      const bytes = Buffer.from(`${size > 0 && last[0] !== 10 ? '\n' : ''}${JSON.stringify(record)}\n`)
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(handle, bytes, offset, bytes.length - offset)
        if (written === 0) throw new Error('Queue journal write made no progress')
        offset += written
      }
      fsyncSync(handle)
    } finally { closeSync(handle) }
    syncDirectory(directory)
  }

  /** Cancel abandoned tickets and retry notices until durable acceptance is marked.
   * Missing and corrupt journals never prevent Session startup.
   * @param parent - newly loaded root Session writer.
   * @param notify - parent notification path; resolves only after the notice is durably accepted.
   */
  async recover(parent: Agent, notify: (record: QueueJournalRecord) => void | Promise<void>): Promise<void> {
    try {
      await this.prepare(parent)
      const directory = this.directories.get(parent)
      if (directory === undefined) return
      let text: string
      try { text = readFileSync(join(directory, 'subagent-queue.jsonl'), 'utf8') }
      catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
      const pending = new Map<string, QueueJournalRecord>()
      let damaged = false
      const lines = text.split('\n')
      for (const [index, line] of lines.entries()) {
        if (line.trim() === '') continue
        if (index === lines.length - 1) { damaged = true; continue }
        try {
          const parsed = recordSchema.parse(JSON.parse(line))
          if (parsed.parentSessionId !== parent.id) { damaged = true; continue }
          const record: QueueJournalRecord = {
            ticketId: brandString<SubagentQueued['ticketId']>(parsed.ticketId),
            parentSessionId: brandString<SessionId>(parsed.parentSessionId),
            agentType: parsed.agentType, position: parsed.position, queuedAt: parsed.queuedAt, state: parsed.state,
            ...parsed.dequeuedAt === undefined ? {} : { dequeuedAt: parsed.dequeuedAt },
            ...parsed.cancelledAt === undefined ? {} : { cancelledAt: parsed.cancelledAt },
            ...parsed.notifiedAt === undefined ? {} : { notifiedAt: parsed.notifiedAt },
            ...parsed.reason === undefined ? {} : { reason: parsed.reason } }
          if (record.state === 'queued' || record.state === 'cancelled') pending.set(record.ticketId, record)
          else pending.delete(record.ticketId)
        } catch (_error) { damaged = true }
      }
      if (damaged) this.ctx.logger.warn('Subagent queue journal contains damaged records; skipped invalid lines, recovery continues')
      for (const record of pending.values()) {
        const cancelled: QueueJournalRecord = record.state === 'cancelled' ? record
          : { ...record, state: 'cancelled', cancelledAt: Date.now(), reason: 'restart' }
        if (record.state !== 'cancelled') this.append(parent, cancelled)
        await notify(cancelled)
        this.append(parent, { ...cancelled, state: 'notified', notifiedAt: Date.now() })
      }
    } catch (_error) {
      this.ctx.logger.warn('Subagent queue recovery could not finish; session remains available, inspect queue storage before redispatching')
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function syncDirectory(directory: string): void {
  const unsupported = (error: unknown) => process.platform === 'win32'
    && ['EPERM', 'EISDIR', 'EINVAL'].some(code => hasCode(error, code))
  let handle: number
  try { handle = openSync(directory, 'r') }
  catch (error) { if (unsupported(error)) return; throw error }
  try {
    try { fsyncSync(handle) }
    catch (error) { if (!unsupported(error)) throw error }
  } finally { closeSync(handle) }
}
