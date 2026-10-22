/** Shared locked reads for the standalone and full ledger message stores. */
import { join } from 'node:path'
import type { MessageCursor, MessageQuery } from '@panedesk/dsh-message-delivery'
import { recoverMessageSegments, type JournalOptions } from './journal.ts'
import { withWriterLock } from './lock.ts'
import type { MessageLedgerPage } from './types.ts'

/** Read retained message facts under the node's writer lock.
 * @param root - Initialized message node directory.
 * @param options - Native lock and encoded record limits.
 * @param query - Filters, exclusive cursor, and optional positive page limit.
 * @returns Selected facts and full-scan completeness; unknown cursors and invalid limits reject.
 */
export async function readMessagePage(root: string, options: JournalOptions, query: MessageQuery): Promise<MessageLedgerPage> {
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const scan = await recoverMessageSegments(root, options.maxRecordBytes)
    const events = scan.events.sort((a, b) => a.observedAt - b.observedAt || a.eventId.localeCompare(b.eventId))
    const cursorIndex = query.cursor === undefined ? -1 : events.findIndex(event => event.eventId === String(query.cursor))
    if (query.cursor !== undefined && cursorIndex < 0) throw new Error('Unknown message ledger cursor')
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) throw new Error('Message limit must be a positive safe integer')
    const selected = events.slice(cursorIndex + 1).filter((event) => {
      const data = event.data
      return (query.nodeId === undefined || event.nodeId === query.nodeId)
        && (query.sessionId === undefined || data.senderSessionId === query.sessionId || data.targetSessionId === query.sessionId)
        && (query.senderSessionId === undefined || data.senderSessionId === query.senderSessionId)
        && (query.targetSessionId === undefined || data.targetSessionId === query.targetSessionId)
        && (query.from === undefined || data.observedAt >= query.from)
        && (query.to === undefined || data.observedAt < query.to)
        && (query.states === undefined || query.states.includes(data.state))
        && (query.messageClasses === undefined || query.messageClasses.includes(data.messageClass))
    })
    const page = selected.slice(0, query.limit)
    const last = page.at(-1)
    return { events: page, complete: scan.complete,
      ...last && page.length < selected.length ? { nextCursor: last.eventId as string as MessageCursor } : {} }
  })
}
