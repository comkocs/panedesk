/** Identity-bearing messages are validated separately from the unchanged legacy send decoder. */
import { decodeMessagesRequest } from '@panedesk/dsh-sdk-protocol'
import { digest, identifier, object } from '@panedesk/dsh-host-admin'
import type { RoutedSendMessageRequest } from '@panedesk/dsh-message-delivery'

/** Validate complete sender-frozen identity and equality with legacy request fields.
 * @param value - Untrusted wire or durable request.
 * @returns Validated identity-bearing send request without minting any identity.
 */
export function decodeRoutedSend(value: unknown): RoutedSendMessageRequest {
  if (!object(value) || !object(value.delivery)) throw new Error('Routed delivery required')
  const { delivery, ...legacy } = value
  decodeMessagesRequest('messages/send', legacy)
  const message = delivery.message
  const { digest: fingerprint, ...envelope } = delivery
  if (!identifier(delivery.deliveryId) || !identifier(delivery.sourceNodeId) || fingerprint !== digest(envelope)
    || Object.keys(delivery).some(key => !['message', 'deliveryId', 'sourceNodeId', 'digest', 'callId', 'rootCallId', 'causedByDeliveryId'].includes(key))
    || ['callId', 'rootCallId', 'causedByDeliveryId'].some(key => delivery[key] !== undefined && !identifier(delivery[key]))
    || !object(message) || !identifier(message.messageId) || !object(message.sender) || !object(message.target)
    || !object(value.target) || !identifier(value.target.sessionId)
    || message.target.nodeId !== value.target.nodeId || message.target.sessionId !== value.target.sessionId
    || !identifier(message.target.nodeId) || !identifier(message.target.sessionId)
    || delivery.sourceNodeId === message.target.nodeId || message.operationId !== value.operationId
    || message.content !== value.content || message.messageClass !== value.messageClass || message.replyTo !== value.replyTo
    || message.priority !== (value.priority ?? (value.messageClass === 'notice' ? 'queue' : 'steer'))
    || !Number.isSafeInteger(message.createdAt) || Number(message.createdAt) < 0
    || message.revision !== 0 || message.mailboxSequence !== 0 || message.stateVersion !== 0
    || message.senderSessionId !== message.sender.sessionId
    || !(message.sender.kind === 'human' ? message.sender.sessionId === null
      : message.sender.kind === 'session' && identifier(message.sender.sessionId))
    || Object.keys(message.sender).some(key => !['kind', 'sessionId'].includes(key))
    || Object.keys(message.target).some(key => !['nodeId', 'sessionId'].includes(key))
    || Object.keys(message).some(key => !['messageId', 'sender', 'senderSessionId', 'target', 'priority', 'content',
      'createdAt', 'revision', 'operationId', 'mailboxSequence', 'stateVersion', 'messageClass', 'replyTo'].includes(key))) {
    throw new Error('Routed delivery identity rejected')
  }
  return value as RoutedSendMessageRequest
}
