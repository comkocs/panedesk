/** Remote sends freeze identity durably before issuing a single-hop delegation. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { MessageSender, SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import { NODE_LINK_VERSION, decodeRoutedSend, type NodeDelegationRequest } from '@panedesk/dsh-node-link'
import { digest } from '@panedesk/dsh-host-admin'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { FileMailbox } from './mailbox.ts'
import { component, MailboxUnavailableError, object, publish, readValue } from './files.ts'
import { decodeSendResult } from './codec.ts'

/** Send or reconcile the same frozen message through the optional router.
 * @param ctx - Trusted entry issuer and optional router.
 * @param mailbox - Sender-owned durable operation storage.
 * @param request - Legacy send input with an exact remote session address.
 * @param sender - Captured live sender, not wire-supplied identity.
 * @returns Target acknowledgement, or an explicit refusal/unknown outcome preserving identity.
 */
export async function sendRoutedMessage(ctx: Context, mailbox: FileMailbox, request: SendMessageRequest,
  sender: MessageSender): Promise<SendMessageResult> {
  const key = component(request.operationId), fingerprint = digest({ sender, request })
  return mailbox.locked(join(mailbox.root, 'operations', `${key}.lock`), async () => {
    const path = join(mailbox.root, 'operations', `${key}.json`)
    const previous = await readValue(path, mailbox.options.maxRecordBytes)
    if (previous !== undefined && (!object(previous) || previous.digest !== fingerprint)) throw new MailboxUnavailableError('operation-conflict')
    if (object(previous) && previous.result !== undefined) return decodeSendResult(previous.result)
    const messageId = createUserMessage({ content: [{ type: 'text', text: request.content }], source: { kind: 'user' } }).id
    const refuse = (reason: 'cross-node-unsupported' | 'unauthorized' | 'unavailable' | 'delivery-uncertain', id = messageId): SendMessageResult => ({
      messageId: id, operationId: request.operationId, deliveryOutcome: 'rejected', messageState: 'rejected', pending: false, reason, candidates: [] })
    const router = ctx.get('nodeRouter'), issuer = ctx.get('nodeDelegationIssuer')
    if (!router || !issuer || request.target.sessionId === undefined || request.target.nodeId === undefined) return refuse('cross-node-unsupported')
    if (['callId', 'rootCallId', 'causedByDeliveryId', 'delivery'].some(key => key in request)) return refuse('unauthorized')
    const envelope = { deliveryId: randomUUID(), sourceNodeId: mailbox.options.nodeId,
      message: { messageId, sender, senderSessionId: sender.sessionId,
        target: { nodeId: request.target.nodeId, sessionId: request.target.sessionId },
        priority: request.priority ?? (request.messageClass === 'notice' ? 'queue' : 'steer'),
        content: request.content, createdAt: Date.now(), revision: 0, mailboxSequence: 0, stateVersion: 0,
        operationId: request.operationId, ...(request.messageClass === 'reply'
          ? { messageClass: request.messageClass, replyTo: request.replyTo } : { messageClass: request.messageClass }) } }
    const payload = decodeRoutedSend(object(previous) ? previous.request
      : { ...request, delivery: { ...envelope, digest: digest(envelope) } })
    if (previous === undefined) await publish(path, { digest: fingerprint, request: payload }, mailbox.options.maxRecordBytes)
    const prepared = { version: NODE_LINK_VERSION, requestId: randomUUID(), sourceNodeId: mailbox.options.nodeId,
      targetNodeId: String(request.target.nodeId), operationId: String(request.operationId),
      deadline: new Date(Date.now() + issuer.expiry.maxLifetimeMs).toISOString(), hop: 1,
      method: 'messages.send', payload, payloadDigest: digest(payload) } as NodeDelegationRequest
    const issued = await issuer.issue(prepared)
    if (issued.status === 'rejected') return refuse('unauthorized', payload.delivery.message.messageId)
    if (sender.kind === 'session' && issued.delegation.sessionId !== sender.sessionId) return refuse('unauthorized', payload.delivery.message.messageId)
    const response = await router.route({ ...prepared, delegation: issued.delegation })
    if (response.status !== 'ok' || response.method !== 'messages.send') {
      return refuse(response.status !== 'ok' && response.error.effectState === 'unknown' ? 'delivery-uncertain' : 'unavailable', payload.delivery.message.messageId)
    }
    const result = response.result
    if (result.messageId !== payload.delivery.message.messageId || result.operationId !== request.operationId) {
      return refuse('delivery-uncertain', payload.delivery.message.messageId)
    }
    await publish(path, { digest: fingerprint, request: payload, result }, mailbox.options.maxRecordBytes)
    return result
  })
}
