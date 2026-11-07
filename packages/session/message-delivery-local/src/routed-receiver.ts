/** Routed mailbox admission retains original identities and durable acknowledgements. */
import { join } from 'node:path'
import type { MessageReason, MessageRecipient, RoutedMessageReceiver,
  RoutedSendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import type { FileMailbox } from './mailbox.ts'
import { component, MailboxUnavailableError, object, publish, readValue } from './files.ts'
import { decodeCommand, decodeSendResult } from './codec.ts'

/** The receiving host owns exact-envelope authority verification and local recipient policy. */
export interface RoutedMailboxOptions {
  readonly mailbox: FileMailbox
  readonly maxContentBytes: number
  /** Resolve only the receiving node's target and receive policy.
   * @param request - Exact target identity and message classification.
   * @returns Local recipient or a safe refusal reason.
   */
  resolve(request: RoutedSendMessageRequest): Promise<MessageRecipient | MessageReason>
  /** Notify the local lease owner only after durable mailbox admission.
   * @param recipient - Target whose mailbox now contains the original message.
   */
  notify(recipient: MessageRecipient): void
}
/** Compose local mailbox ownership with explicit host authority verification.
 * @param options - Local mailbox, current policy and lease-owner notification.
 * @returns Receiver that never calls send or a node router.
 */
export function createRoutedMailboxReceiver(options: RoutedMailboxOptions): RoutedMessageReceiver {
  const mailbox = options.mailbox
  return { receive: async (input) => {
    // Register synchronously, but load optional transports only for routed traffic.
    const { decodeRoutedSend } = await import('@panedesk/dsh-'.concat('node-link')) as typeof import('@panedesk/dsh-node-link')
    const { digest } = await import('@panedesk/dsh-'.concat('host-admin')) as typeof import('@panedesk/dsh-host-admin')
    const request = decodeRoutedSend(input), envelope = request.delivery, message = envelope.message
    const rejected = (reason: Exclude<MessageReason, 'target-closed-pending'>): SendMessageResult => ({
      messageId: message.messageId, operationId: message.operationId, deliveryOutcome: 'rejected',
      messageState: 'rejected', pending: false, reason, candidates: [] })
    if (message.target.nodeId !== mailbox.options.nodeId) return rejected('cross-node-unsupported')
    return mailbox.locked(join(mailbox.root, 'operations', 'routed.lock'), async () => {
      const identities = [envelope.deliveryId, message.messageId, message.operationId].map((id, index) =>
        join(mailbox.root, 'operations', `routed-${index}-${digest([envelope.sourceNodeId, id])}.json`))
      let settled: SendMessageResult | undefined
      for (const path of identities) {
        const previous = await readValue(path, mailbox.options.maxRecordBytes)
        if (previous !== undefined) {
          if (!object(previous) || previous.digest !== envelope.digest) return rejected('operation-conflict')
          if (previous.result !== undefined) settled = decodeSendResult(previous.result)
        }
      }
      if (settled !== undefined) return settled
      // Identity reservations precede admission; an interrupted reservation can only resume this exact envelope.
      for (const path of identities) await publish(path, { digest: envelope.digest, delivery: envelope }, mailbox.options.maxRecordBytes)
      const target = component(message.target.sessionId)
      const prior = (await mailbox.snapshot(target)).records.find(record => record.operationId === message.operationId)
      let result: SendMessageResult
      if (prior) {
        if (prior.digest !== envelope.digest) return rejected('operation-conflict')
        const command = decodeCommand(prior.value)
        if (command.kind !== 'send') throw new MailboxUnavailableError('Routed operation identity conflict')
        result = command.result
      } else {
        const recipient = await options.resolve(request)
        if (typeof recipient === 'string') result = rejected(recipient === 'target-closed-pending' ? 'unavailable' : recipient)
        else if (!message.content.trim() || Buffer.byteLength(message.content) > options.maxContentBytes) result = rejected('invalid-content')
        else if (message.messageClass === 'notice' && message.priority !== 'queue') result = rejected('invalid-priority')
        else {
          result = recipient.status === 'closed'
            ? { messageId: message.messageId, operationId: message.operationId, deliveryOutcome: 'rejected',
              reason: 'target-closed-pending', messageState: 'queued', pending: true, recipient }
            : { messageId: message.messageId, operationId: message.operationId, deliveryOutcome: 'accepted',
              messageState: 'queued', pending: false, recipient }
          const record = await mailbox.append(target, message.operationId, envelope.digest, decodeCommand({ kind: 'send', message, result }, 'request'))
          const command = decodeCommand(record.value)
          if (command.kind !== 'send') throw new MailboxUnavailableError('Routed operation identity conflict')
          result = command.result
        }
      }
      for (const path of identities) {
        await publish(path, { digest: envelope.digest, delivery: envelope, result }, mailbox.options.maxRecordBytes)
      }
      if ('recipient' in result) options.notify(result.recipient)
      return result
    })
  } }
}
