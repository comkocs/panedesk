/** Receipt-only replay uses publication order, never wall-clock order or inbox delivery. */
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import type { MessageCursor, MessageStateEvent, MessageSubscriptionRequest } from '@panedesk/dsh-message-delivery'
import type { FileMailbox } from './mailbox.ts'
import { decodeReceipt } from './codec.ts'
import { MailboxUnavailableError, publish, publishedFiles, readValue } from './files.ts'

/** Serializes receipt publication and subscription cuts across local processes. */
export class ReceiptStore {
  constructor(private readonly mailbox: FileMailbox) {}

  private async records(): Promise<MessageStateEvent[]> {
    const events: MessageStateEvent[] = []
    for (const target of await readdir(join(this.mailbox.root, 'mailboxes'))) {
      const directory = join(this.mailbox.root, 'mailboxes', target, 'receipts')
      for (const name of await publishedFiles(directory)) {
        if (name.startsWith('operation-')) continue
        events.push(decodeReceipt(await readValue(join(directory, name), this.mailbox.options.maxRecordBytes)))
      }
    }
    return events.sort((left, right) => {
      const a = left.cursor.startsWith('receipt:')
      const b = right.cursor.startsWith('receipt:')
      return a && b ? left.cursor.localeCompare(right.cursor) : a ? 1 : b ? -1
        : left.data.observedAt - right.data.observedAt || left.cursor.localeCompare(right.cursor)
    })
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return this.mailbox.locked(join(this.mailbox.root, 'operations', 'receipt-order.lock'), work)
  }

  /** Publish once under the original decision identity, assigning a stable monotonic cursor.
   * @param event - committed owner decision; retries retain the first publication.
   * @returns durable receipt with its subscription cursor.
   */
  async publish(event: MessageStateEvent): Promise<MessageStateEvent> {
    const target = event.data.targetSessionId
    if (!target) throw new MailboxUnavailableError('Receipt has no target')
    const root = await this.mailbox.target(target)
    const name = createHash('sha256').update(event.cursor).digest('hex')
    const path = join(root, 'receipts', `${name}.json`)
    return this.locked(async () => {
      const previous = await readValue(path, this.mailbox.options.maxRecordBytes)
      if (previous !== undefined) return decodeReceipt(previous)
      const last = (await this.records()).at(-1)
      const sequence = last?.cursor.startsWith('receipt:') ? Number(last.cursor.slice(8)) + 1 : 1
      if (!Number.isSafeInteger(sequence)) throw new MailboxUnavailableError('Receipt sequence exhausted')
      const receipt = { ...event, cursor: `receipt:${String(sequence).padStart(16, '0')}` as MessageCursor }
      await publish(path, receipt, this.mailbox.options.maxRecordBytes)
      return receipt
    })
  }

  /** Follow durable receipt cuts without adding agent input or requesting wakeup.
   * @param request - authorized Session and optional last consumed cursor.
   * @param interval - configured fallback scan interval.
   * @param signal - service lifetime; abort ends the iterator.
   * @returns receipts strictly after the supplied cursor; unknown cursors fail explicitly.
   */
  async *subscribe(request: MessageSubscriptionRequest, interval: number, signal: AbortSignal): AsyncIterable<MessageStateEvent> {
    let cursor = request.cursor
    while (!signal.aborted) {
      const events = await this.locked(() => this.records())
      const index = cursor === undefined ? -1 : events.findIndex(event => event.cursor === cursor)
      if (cursor !== undefined && index < 0) throw new MailboxUnavailableError('Receipt cursor is unavailable')
      for (const event of events.slice(index + 1)) {
        cursor = event.cursor
        if (event.data.senderSessionId === request.sessionId || event.data.targetSessionId === request.sessionId) yield event
      }
      try { await wait(interval, undefined, { signal }) } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        throw error
      }
    }
  }
}
