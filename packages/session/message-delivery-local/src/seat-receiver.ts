/** Target-local seat resolution commits the original identity and never routes a delivery onward. */
import { join } from 'node:path'
import type { MessageReason, MessageRecipient, RoutedDeliveryAuthority, RoutedSeatMessageRequest,
  RoutedSeatMessageReceiver, SendMessageResult, OnlineSeat } from '@panedesk/dsh-message-delivery'
import type { FileMailbox } from './mailbox.ts'
import { MailboxUnavailableError, object, publish, readValue } from './files.ts'
import { decodeCommand, decodeSendResult } from './codec.ts'

/** Local-only admission dependencies; the host owns the unforgeable capability. */
export interface SeatReceiverOptions {
  readonly mailbox: FileMailbox
  readonly maxContentBytes: number
  /** @param authority - Host-issued capability. @param request - Frozen request. @returns Current exact permission. */
  authorize(authority: RoutedDeliveryAuthority, request: RoutedSeatMessageRequest): Promise<boolean>
  /** @param request - Exact seat and classification. @returns Current local target or refusal. */
  resolve(request: RoutedSeatMessageRequest): Promise<MessageRecipient | MessageReason>
  /** @param recipient - Durably admitted target. */
  notify(recipient: MessageRecipient): void
  /** @returns Verified local observations without a reservation. */
  online(): Promise<readonly OnlineSeat[]>
}
/** Compose idempotent target resolution with the local mailbox owner.
 * @param options - Local storage, policy and runtime observations.
 * @returns Receiver retaining the original sender, operation, message and delivery identifiers.
 */
export function createSeatMessageReceiver(options: SeatReceiverOptions): RoutedSeatMessageReceiver {
  const mailbox = options.mailbox
  return { online: () => options.online(), receive: async (input, authority) => {
    const { decodeRoutedSeatSend } = await import('@panedesk/dsh-'.concat('node-link')) as typeof import('@panedesk/dsh-node-link')
    const { digest } = await import('@panedesk/dsh-'.concat('host-admin')) as typeof import('@panedesk/dsh-host-admin')
    const request = decodeRoutedSeatSend(input), envelope = request.delivery, message = envelope.message
    const reject = (reason: Exclude<MessageReason, 'target-closed-pending'>): SendMessageResult => ({
      messageId: message.messageId, operationId: message.operationId, deliveryOutcome: 'rejected',
      messageState: 'rejected', pending: false, reason, candidates: [] })
    if (authority.sourceNodeId !== envelope.sourceNodeId || authority.targetNodeId !== mailbox.options.nodeId
      || message.target.nodeId !== mailbox.options.nodeId || !await options.authorize(authority, request)) return reject('unauthorized')
    return mailbox.locked(join(mailbox.root, 'operations', 'routed.lock'), async () => {
      const paths = [envelope.deliveryId, message.messageId, message.operationId].map((id, index) =>
        join(mailbox.root, 'operations', `routed-${index}-${digest([envelope.sourceNodeId, id])}.json`))
      if (!await options.authorize(authority, request)) return reject('unauthorized')
      let recipient: MessageRecipient | undefined
      let settled: SendMessageResult | undefined
      for (const path of paths) {
        const prior = await readValue(path, mailbox.options.maxRecordBytes)
        if (prior !== undefined) {
          if (!object(prior) || prior.digest !== envelope.digest) return reject('operation-conflict')
          if (prior.result !== undefined) {
            const result = decodeSendResult(prior.result)
            if (result.messageId !== message.messageId || result.operationId !== message.operationId
              || settled && digest(settled) !== digest(result)) {
              throw new MailboxUnavailableError('Retained seat delivery requires reconciliation')
            }
            settled = result
          }
          if (prior.recipient !== undefined) {
            const projected = decodeSendResult({ messageId: message.messageId, operationId: message.operationId,
              deliveryOutcome: 'accepted', messageState: 'queued', pending: false, recipient: prior.recipient })
            if ('recipient' in projected) {
              if (recipient && (recipient.nodeId !== projected.recipient.nodeId
                || recipient.sessionId !== projected.recipient.sessionId)) {
                throw new MailboxUnavailableError('Retained seat delivery requires reconciliation')
              }
              recipient = projected.recipient
            }
          }
        }
      }
      if (settled) {
        if (recipient && (settled.deliveryOutcome !== 'accepted'
          || settled.recipient.sessionId !== recipient.sessionId || settled.recipient.nodeId !== recipient.nodeId)) {
          throw new MailboxUnavailableError('Retained seat delivery requires reconciliation')
        }
        return settled
      }
      let result: SendMessageResult
      if (recipient === undefined) {
        const resolved = await options.resolve(request)
        if (typeof resolved === 'string') result = reject(resolved === 'target-closed-pending' ? 'offline' : resolved)
        else if (resolved.status === 'closed') result = reject('offline')
        else if (!message.content.trim() || Buffer.byteLength(message.content) > options.maxContentBytes) result = reject('invalid-content')
        else if (message.messageClass === 'notice' && message.priority !== 'queue') result = reject('invalid-priority')
        else { recipient = resolved; result = { messageId: message.messageId, operationId: message.operationId,
          deliveryOutcome: 'accepted', messageState: 'queued', pending: false, recipient } }
      } else {
        const existing = (await mailbox.snapshot(recipient.sessionId)).records.find(row => row.operationId === message.operationId)
        if (existing) {
          if (existing.digest !== envelope.digest) return reject('operation-conflict')
          const command = decodeCommand(existing.value)
          if (command.kind !== 'send') return reject('operation-conflict')
          for (const path of paths) {
            await publish(path, { digest: envelope.digest, delivery: envelope, result: command.result }, mailbox.options.maxRecordBytes)
          }
          return command.result
        }
        const current = await options.resolve(request)
        if (typeof current === 'string' || current.status === 'closed'
          || current.nodeId !== recipient.nodeId || current.sessionId !== recipient.sessionId) {
          throw new MailboxUnavailableError('Retained seat delivery requires reconciliation')
        }
        result = { messageId: message.messageId, operationId: message.operationId,
          deliveryOutcome: 'accepted', messageState: 'queued', pending: false, recipient }
      }
      if (!await options.authorize(authority, request)) return reject('unauthorized')
      // Pin the resolved window before append so a crash cannot redirect an uncertain original send.
      for (const path of paths) await publish(path, { digest: envelope.digest, delivery: envelope,
        ...(recipient ? { recipient } : { result }) }, mailbox.options.maxRecordBytes)
      if (recipient) {
        const storedMessage = { ...message, target: { nodeId: recipient.nodeId, sessionId: recipient.sessionId } }
        const record = await mailbox.append(recipient.sessionId, message.operationId, envelope.digest,
          decodeCommand({ kind: 'send', message: storedMessage, result }, 'request'))
        const command = decodeCommand(record.value)
        if (command.kind !== 'send') return reject('operation-conflict')
        result = command.result
      }
      for (const path of paths) await publish(path, { digest: envelope.digest, delivery: envelope, result }, mailbox.options.maxRecordBytes)
      if (recipient) options.notify(recipient)
      return result
    })
  } }
}
