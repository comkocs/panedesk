/** Remote sends freeze identity durably before issuing a single-hop delegation. */
import { randomUUID } from 'node:crypto'
import { opendir } from 'node:fs/promises'
import type { Dir } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { MessageSender, SendMessageRequest, SendMessageResult, SendSeatMessageRequest } from '@panedesk/dsh-message-delivery'
import type { NodeDelegationRequest, NodeLinkFailure } from '@panedesk/dsh-node-link'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { FileMailbox } from './mailbox.ts'
import { component, MailboxUnavailableError, object, publish, readValue } from './files.ts'
import { decodeSendResult } from './codec.ts'

/** Send or reconcile the same frozen message through the optional router.
 * @param ctx - Trusted entry issuer and optional router.
 * @param mailbox - Sender-owned durable operation storage.
 * @param request - Legacy send input with an exact remote session address.
 * @param sender - Captured live sender, not wire-supplied identity.
 * @param active - Recovery lifetime checked before dispatch; ordinary sends remain active.
 * @returns Target acknowledgement, or an explicit refusal/unknown outcome preserving identity.
 */
export async function sendRoutedMessage(ctx: Context, mailbox: FileMailbox, request: SendMessageRequest | SendSeatMessageRequest,
  sender: MessageSender, active: () => boolean = () => true): Promise<SendMessageResult> {
  // Computed imports keep optional transports out of the default worker image.
  const { NODE_LINK_VERSION, decodeRoutedSend, decodeRoutedSeatSend } = await import('@panedesk/dsh-'.concat('node-link')) as typeof import('@panedesk/dsh-node-link')
  const seat = 'seat' in request.target
  const decode = seat ? decodeRoutedSeatSend : decodeRoutedSend
  const { digest } = await import('@panedesk/dsh-'.concat('host-admin')) as typeof import('@panedesk/dsh-host-admin')
  const key = component(request.operationId), fingerprint = digest({ sender, request })
  return mailbox.locked(join(mailbox.root, 'operations', `${key}.lock`), async () => {
    const path = join(mailbox.root, 'operations', `${key}.json`)
    const previous = await readValue(path, mailbox.options.maxRecordBytes)
    if (previous !== undefined && (!object(previous) || previous.digest !== fingerprint)) throw new MailboxUnavailableError('operation-conflict')
    if (object(previous) && previous.result !== undefined) return decodeSendResult(previous.result)
    const messageId = createUserMessage({ content: [{ type: 'text', text: request.content }], source: { kind: 'user' } }).id
    const refuse = (reason: 'cross-node-unsupported' | 'unauthorized' | 'unavailable' | 'delivery-uncertain',
      id = messageId, error?: NodeLinkFailure): SendMessageResult => decodeSendResult({
      messageId: id, operationId: request.operationId, deliveryOutcome: 'rejected', messageState: 'rejected', pending: false, reason, candidates: [],
      ...(error === undefined ? {} : { cause: {
        domain: 'node-link', code: error.code, reason: error.reason, effectState: error.effectState,
        retryable: error.retryable, operationId: String(error.operationId), nodeId: String(error.targetNodeId),
        ...('reasonCode' in error ? { reasonCode: error.reasonCode } : {}),
      } }),
    })
    const unknown = object(previous) && previous.phase === 'unknown'
    const router = ctx.get('nodeRouter'), issuer = ctx.get('nodeDelegationIssuer')
    if (!router || !issuer || (!('seat' in request.target) && request.target.sessionId === undefined) || request.target.nodeId === undefined) {
      return refuse(unknown ? 'delivery-uncertain' : 'cross-node-unsupported',
        object(previous) ? decode(previous.request).delivery.message.messageId : messageId)
    }
    const envelope = { deliveryId: randomUUID(), sourceNodeId: mailbox.options.nodeId,
      message: { messageId, sender, senderSessionId: sender.sessionId,
        target: request.target,
        priority: request.priority ?? (request.messageClass === 'notice' ? 'queue' : 'steer'),
        content: request.content, createdAt: Date.now(), revision: 0, mailboxSequence: 0, stateVersion: 0,
        operationId: request.operationId, ...(request.messageClass === 'reply'
          ? { messageClass: request.messageClass, replyTo: request.replyTo } : { messageClass: request.messageClass }) } }
    const payload = decode(object(previous) ? previous.request
      : { ...request, delivery: { ...envelope, digest: digest(envelope) } })
    if (previous === undefined) await publish(path, { digest: fingerprint, request: payload }, mailbox.options.maxRecordBytes)
    const prepared = { version: NODE_LINK_VERSION, requestId: randomUUID(), sourceNodeId: mailbox.options.nodeId,
      targetNodeId: String(request.target.nodeId), operationId: String(request.operationId),
      deadline: new Date(Date.now() + issuer.expiry.maxLifetimeMs).toISOString(), hop: 1,
      method: seat ? 'messages.sendSeat' : 'messages.send', payload, payloadDigest: digest(payload) } as NodeDelegationRequest
    const issued = await issuer.issue(prepared)
    if (issued.status === 'rejected') {
      if (object(previous) && previous.phase === 'unknown') return refuse('delivery-uncertain', payload.delivery.message.messageId,
        { ...issued.error, effectState: 'unknown' })
      const result = refuse('unauthorized', payload.delivery.message.messageId, issued.error)
      await publish(path, { digest: fingerprint, request: payload, result }, mailbox.options.maxRecordBytes)
      return result
    }
    if (sender.kind === 'session' && issued.delegation.sessionId !== sender.sessionId) {
      return refuse(unknown ? 'delivery-uncertain' : 'unauthorized', payload.delivery.message.messageId)
    }
    const authority = { principalId: issued.delegation.principalId, sessionId: issued.delegation.sessionId ?? null,
      seat: issued.delegation.seat ?? null, taskIds: issued.delegation.taskIds }
    if (object(previous) && previous.authority !== undefined && digest(previous.authority) !== digest(authority)) {
      return refuse('delivery-uncertain', payload.delivery.message.messageId)
    }
    if (!active()) return refuse('delivery-uncertain', payload.delivery.message.messageId)
    await publish(path, { digest: fingerprint, request: payload, phase: 'unknown', authority }, mailbox.options.maxRecordBytes)
    if (!active()) return refuse('delivery-uncertain', payload.delivery.message.messageId)
    const response = await router.route({ ...prepared, delegation: issued.delegation }, { reconcile: unknown, active })
    if (response.status !== 'ok' || response.method !== prepared.method
      || (response.method !== 'messages.send' && response.method !== 'messages.sendSeat')) {
      const uncertain = unknown || response.status !== 'ok' && response.error.effectState === 'unknown'
      const result = refuse(uncertain ? 'delivery-uncertain' : 'unavailable',
        payload.delivery.message.messageId, response.status === 'ok' ? undefined
          : uncertain ? { ...response.error, effectState: 'unknown' } : response.error)
      if (!uncertain) await publish(path, { digest: fingerprint, request: payload, result }, mailbox.options.maxRecordBytes)
      return result
    }
    const result = decodeSendResult(response.result)
    if (result.messageId !== payload.delivery.message.messageId || result.operationId !== request.operationId) {
      return refuse('delivery-uncertain', payload.delivery.message.messageId)
    }
    await publish(path, { digest: fingerprint, request: payload, result }, mailbox.options.maxRecordBytes)
    return result
  })
}

/** Provider-owned directory cursor; close an unfinished cursor during disposal. */
export interface RoutedRecoveryScan {
  /** Maximum directory entries inspected per scan, including non-message records. */
  readonly maxEntries: number
  /** Open cursor retained between scans so earlier terminal records cannot starve later messages. */
  directory?: Dir | undefined
}

/** Reconcile uncertain direct messages using a live sender and freshly checked entry authority.
 * @param ctx - Provider-owned context and current delegation issuer.
 * @param mailbox - Original durable sender storage.
 * @param run - Re-enters a live sender scope; returns false when its authority is unavailable.
 * @param active - Lifetime check before each accepted recovery.
 * @param scan - Provider-owned bounded directory cursor, retained until exhaustion or disposal.
 */
export async function recoverRoutedMessages(ctx: Context, mailbox: FileMailbox,
  run: (sender: MessageSender, work: (live?: () => boolean) => Promise<void>) => Promise<boolean>, active: () => boolean,
  scan: RoutedRecoveryScan): Promise<void> {
  if (!ctx.get('nodeRouter') || !ctx.get('nodeDelegationIssuer')) return
  const { decodeRoutedSend, decodeRoutedSeatSend } = await import('@panedesk/dsh-'.concat('node-link')) as typeof import('@panedesk/dsh-node-link')
  const directory = join(mailbox.root, 'operations')
  scan.directory ??= await opendir(directory)
  for (let inspected = 0; inspected < scan.maxEntries; inspected++) {
    if (!active()) return
    const entry = await scan.directory.read()
    if (entry === null) {
      await scan.directory.close()
      scan.directory = undefined
      return
    }
    if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    try {
      const value = await readValue(join(directory, entry.name), mailbox.options.maxRecordBytes)
      if (!object(value) || value.phase !== 'unknown' || value.result !== undefined || value.authority === undefined) continue
      const payload = object(value.request) && object(value.request.target) && 'seat' in value.request.target
        ? decodeRoutedSeatSend(value.request) : decodeRoutedSend(value.request)
      const { delivery, ...request } = payload
      await run(delivery.message.sender, async (live = active) => {
        const current = () => active() && live()
        if (current()) await sendRoutedMessage(ctx, mailbox, request, delivery.message.sender, current)
      })
    } catch (error) {
      void error
      ctx.logger.error('Routed message recovery unavailable for one retained operation; continuing the bounded scan')
    }
  }
}
