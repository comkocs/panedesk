/** Owner-scoped quarantine accounting uses the independent message journal. */
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { MessageId } from '@panedesk/dsh-llm'
import type { MessageQuarantineData } from '@panedesk/dsh-message-delivery'
import type { LedgerEventId, LedgerNodeId, MessageLedgerStore } from '@panedesk/dsh-session-ledger'
import { MailboxRecordError, MailboxUnavailableError, object, quarantineFile } from './files.ts'

/** Recover only a nonempty identity, never incomplete message fields.
 * @param value - decoded but invalid record or command.
 * @returns optional sender-minted identity.
 */
export function quarantineMessageId(value: unknown): MessageId | undefined {
  if (!object(value)) return undefined
  const command = object(value.value) ? value.value : value
  const id = object(command.message) ? command.message.messageId : command.messageId
  return typeof id === 'string' && id.length > 0 ? id as MessageId : undefined
}

/** Retain one accounting fact before moving the original private evidence.
 * @param options - owner-verified record and journal capabilities.
 */
export async function quarantineRecord(options: {
  home: string
  root: string
  name: string
  nodeId: LedgerNodeId
  error: MailboxRecordError
  ledger: MessageLedgerStore | undefined
  diagnose: (name: string, path: string) => void
}): Promise<void> {
  const { home, root, name, nodeId, error, ledger } = options
  if (!ledger) throw new MailboxUnavailableError('Quarantine requires message accounting')
  const messageId = quarantineMessageId(error.value)
  const data: MessageQuarantineData = { originalFileName: name, reason: error.reason,
    ...messageId === undefined ? {} : { messageId } }
  const eventId = `message/quarantined:${createHash('sha256').update(JSON.stringify([nodeId, basename(root), name])).digest('hex')}` as LedgerEventId
  const previous = (await ledger.read({})).events.find(event => event.eventId === eventId)
  if (!previous) await ledger.append({ schemaVersion: 1, kind: 'message/quarantined', eventId, nodeId, observedAt: Date.now(), data })
  const destination = join(root, 'quarantine', name)
  await quarantineFile(home, join(root, 'records', name), destination)
  options.diagnose(name, destination)
}
