/** Sequenced per-target files with native short locks and recoverable publication watermarks. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { acquireExclusiveLockFile } from '@panedesk/node-addon-system/flock'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { component, MailboxRecordError, MailboxUnavailableError, object, privateDirectory, publish, publishedFiles, readValue } from './files.ts'
import { decodeCommand } from './codec.ts'

/** Resolved storage limits; lock expiry never permits stealing ownership. */
export interface MailboxOptions {
  readonly home: string
  readonly nodeId: string
  readonly maxRecordBytes: number
  readonly lockTimeoutMs: number
  readonly lockRetryMs: number
}

/** One committed command; sends and controls share this sequence. */
export interface MailboxRecord {
  readonly sequence: number
  readonly operationId: string
  readonly digest: string
  readonly value: unknown
}

/** Owns one node's files; business decoding remains with the delivery service. */
export class FileMailbox {
  /** Private storage root for this node's registry and mailboxes. */
  readonly root: string
  /** Owner-installed accounting; absent ownership leaves damaged evidence untouched. */
  readonly quarantines = new Map<string, (root: string, name: string, error: MailboxRecordError) => Promise<void>>()
  constructor(readonly options: MailboxOptions) {
    this.root = join(options.home, 'messages', 'nodes', component(options.nodeId))
  }

  /** Initialize private node directories without opening any Session. */
  async initialize(): Promise<void> {
    for (const child of ['registry', 'mailboxes', 'owners', 'operations']) {
      await privateDirectory(this.options.home, join(this.root, child))
    }
  }

  /** Resolve and initialize one target's storage.
   * @param sessionId - exact target identity.
   * @returns private target root.
   */
  async target(sessionId: string): Promise<string> {
    const root = join(this.root, 'mailboxes', component(sessionId))
    for (const child of ['records', 'decisions', 'receipts', 'quarantine']) await privateDirectory(this.options.home, join(root, child))
    return root
  }

  /** Execute one short transaction under an OS lock.
   * @param path - lock file in a validated private directory.
   * @param task - operation completed before releasing the descriptor.
   * @returns operation result.
   */
  async locked<T>(path: string, task: () => Promise<T>): Promise<T> {
    if (process.platform === 'win32') {
      let handle
      try {
        handle = await acquireExclusiveLockFile(path, { timeoutMs: this.options.lockTimeoutMs, retryMs: this.options.lockRetryMs })
      } catch (error) {
        if (object(error) && error.code === 'EAGAIN') throw new MailboxUnavailableError('Mailbox lock timed out', { cause: error })
        throw error
      }
      try { return await task() } finally { await handle.close() }
    }
    const { tryLockExclusive } = await import('@panedesk/node-addon-system/flock')
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      const deadline = performance.now() + this.options.lockTimeoutMs
      while (true) {
        try { await tryLockExclusive(handle.fd); break } catch (error) {
          if (!object(error) || (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK')) throw error
          const remaining = deadline - performance.now()
          if (remaining <= 0) throw new MailboxUnavailableError('Mailbox lock timed out', { cause: error })
          await setTimeout(Math.min(remaining, this.options.lockRetryMs))
        }
      }
      const held = await handle.stat()
      const named = await lstat(path)
      if (!held.isFile() || named.isSymbolicLink() || held.nlink !== 1 || held.ino !== named.ino || held.dev !== named.dev
        || held.uid !== process.getuid?.() || (held.mode & 0o077) !== 0) {
        throw new MailboxUnavailableError('Mailbox lock identity or permissions changed')
      }
      return await task()
    } finally { await handle.close() }
  }

  /** Append or replay an operation under the shared message/control sequence.
   * @param sessionId - target identity.
   * @param operationId - idempotency identity.
   * @param digest - canonical request digest.
   * @param value - command payload.
   * @returns the first committed record; conflicting reuse rejects.
   */
  async append(sessionId: string, operationId: string, digest: string, value: unknown): Promise<MailboxRecord> {
    const root = await this.target(sessionId)
    return this.locked(join(root, 'publish.lock'), async () => {
      const publishedHigh = await this.publishedHigh(root)
      const records = await this.scan(root)
      const previous = records.find(record => record.operationId === operationId)
      if (previous) {
        if (previous.digest !== digest) throw new MailboxUnavailableError('Conflicting mailbox operation')
        return previous
      }
      const persisted = await readValue(join(root, 'watermark.json'), this.options.maxRecordBytes)
      if (persisted !== undefined && (!object(persisted) || !Number.isSafeInteger(persisted.sequence) || Number(persisted.sequence) < 0)) {
        throw new MailboxUnavailableError('Invalid mailbox watermark')
      }
      const high = Math.max(publishedHigh, records.at(-1)?.sequence ?? 0, object(persisted) ? Number(persisted.sequence) : 0)
      if (!Number.isSafeInteger(high + 1)) throw new MailboxUnavailableError('Mailbox sequence exhausted')
      const record = { sequence: high + 1, operationId, digest, value }
      await publish(join(root, 'records', `${String(record.sequence).padStart(16, '0')}.json`), record, this.options.maxRecordBytes)
      await publish(join(root, 'watermark.json'), { sequence: record.sequence }, this.options.maxRecordBytes)
      return record
    })
  }

  /** Capture a published high-water cut while excluding concurrent publishers.
   * @param sessionId - target identity.
   * @returns committed records and explicit missing sequence ranges.
   */
  async snapshot(sessionId: string): Promise<{ records: MailboxRecord[]; high: number; skipped: [number, number][] }> {
    const root = await this.target(sessionId)
    return this.locked(join(root, 'publish.lock'), async () => {
      const publishedHigh = await this.publishedHigh(root)
      const records = await this.scan(root)
      const persisted = await readValue(join(root, 'watermark.json'), this.options.maxRecordBytes)
      if (persisted !== undefined && (!object(persisted) || !Number.isSafeInteger(persisted.sequence) || Number(persisted.sequence) < 0)) {
        throw new MailboxUnavailableError('Invalid mailbox watermark')
      }
      const high = Math.max(publishedHigh, records.at(-1)?.sequence ?? 0, object(persisted) ? Number(persisted.sequence) : 0)
      const skipped: [number, number][] = []
      let next = 1
      for (const record of records) {
        if (record.sequence > next) skipped.push([next, record.sequence - 1])
        next = record.sequence + 1
      }
      if (next <= high) skipped.push([next, high])
      await publish(join(root, 'watermark.json'), { sequence: high, skipped }, this.options.maxRecordBytes)
      return { records, high, skipped }
    })
  }

  private async publishedHigh(root: string): Promise<number> {
    let high = 0
    for (const directory of ['records', 'quarantine']) {
      for (const name of await publishedFiles(join(root, directory))) {
        if (/^\d{16}\.json$/.test(name) && Number.isSafeInteger(Number(name.slice(0, -5)))) high = Math.max(high, Number(name.slice(0, -5)))
      }
    }
    return high
  }

  private async scan(root: string): Promise<MailboxRecord[]> {
    const records: MailboxRecord[] = []
    for (const name of await publishedFiles(join(root, 'records'))) {
      try {
        const value = await readValue(join(root, 'records', name), this.options.maxRecordBytes)
        if (!object(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0
          || typeof value.operationId !== 'string' || typeof value.digest !== 'string'
          || name !== `${String(value.sequence).padStart(16, '0')}.json` || !('value' in value)) {
          throw new MailboxRecordError('Invalid published mailbox record', 'invalid-fields', value)
        }
        if (this.quarantines.has(root)) decodeCommand(value.value)
        records.push({ sequence: Number(value.sequence), operationId: value.operationId, digest: value.digest, value: value.value })
      } catch (error) {
        if (!(error instanceof MailboxRecordError)) throw error
        await this.quarantines.get(root)?.(root, name, error)
      }
    }
    return records
  }
}
