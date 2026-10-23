/** Synchronous execution-bound records precede producer effects and retain pending delivery. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@panedesk/dsh-session'
import { digest, EngineError } from './journal.ts'

/** Private notification record; owner loss never implies producer success. */
export interface NotificationRecord {
  version: 1
  id: string
  owner: SessionId | null
  phase: 'intent' | 'running' | 'settled' | 'owner-lost'
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'
  text: string
  delivered: boolean
  observedAt: string
}

/** One engine owner holds this store under its existing node lock. */
export class NotificationStore {
  /** Recovered and committed notification states keyed by immutable execution identity. */
  readonly records = new Map<string, NotificationRecord>()
  private failed = false
  constructor(private readonly root: string, private readonly maxBytes: number) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(root).filter(name => name.endsWith('.json'))) {
      const bytes = readFileSync(join(root, file))
      if (bytes.length > maxBytes) throw new EngineError('engine-store-corrupt', 'Notification record exceeds its bound')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (!this.valid(value) || file !== `${digest(value.id)}.json`) {
        throw new EngineError('engine-store-corrupt', 'Invalid notification record')
      }
      this.records.set(value.id, value)
    }
    for (const record of this.records.values()) {
      if (record.phase === 'intent' || record.phase === 'running') this.put({ ...record, phase: 'owner-lost',
        outcome: 'unknown', text: `${record.text}\nOutcome unknown: execution owner lost. Do not replay external work.` })
    }
  }
  private valid(value: unknown): value is NotificationRecord {
    if (!value || typeof value !== 'object') return false
    const item = value as Record<string, unknown>
    return item.version === 1 && typeof item.id === 'string' && item.id.length > 0
      && (item.owner === null || typeof item.owner === 'string')
      && ['intent', 'running', 'settled', 'owner-lost'].includes(String(item.phase))
      && ['completed', 'failed', 'cancelled', 'unknown'].includes(String(item.outcome))
      && typeof item.text === 'string' && typeof item.delivered === 'boolean'
      && typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt))
  }
  /** Commit synchronously; an uncertain write disables further writes until recovery.
   * @param record - complete replacement state for one immutable execution identity.
   */
  put(record: NotificationRecord): void {
    if (this.failed) throw new EngineError('unavailable', 'Notification storage requires recovery')
    const text = JSON.stringify(record)
    if (Buffer.byteLength(text) > this.maxBytes) throw new EngineError('source-payload-too-large', 'Notification exceeds its bound')
    const temporary = join(this.root, `${randomUUID()}.pending`)
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, join(this.root, `${digest(record.id)}.json`))
      const directory = openSync(this.root, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
      this.records.set(record.id, record)
    } catch (cause) {
      this.failed = true
      throw new EngineError('unavailable', 'Notification write outcome requires recovery', { cause })
    }
  }
}
