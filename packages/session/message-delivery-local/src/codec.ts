/** Durable JSON validation for mailbox commands, decisions, and receipts. */
import { z } from 'zod'
import type { MessageId } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import type {
  ControlResult, DeliveryMessage, MessageCursor, MessageReason, MessageStateData,
  MessageStateEvent, MessageStatus, NodeId, OperationId, SendMessageResult,
} from '@panedesk/dsh-message-delivery'
import type { ControlCommand, Decision, SendCommand } from './types.ts'
import { MailboxUnavailableError } from './files.ts'

const integer = z.number().int().nonnegative()
const messageId = z.string().min(1).transform(value => value as MessageId)
const sessionId = z.string().min(1).transform(value => value as SessionId)
const operationId = z.string().min(1).transform(value => value as OperationId)
const nodeId = z.string().min(1).transform(value => value as NodeId)
const priority = z.enum(['immediate', 'steer', 'queue'])
const state = z.enum(['queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected'])
const reason = z.enum([
  'target-closed-pending', 'target-archived', 'target-not-found', 'target-ambiguous',
  'receive-disabled', 'handoff-only', 'cross-node-unsupported', 'claimed', 'injected',
  'revision-conflict', 'operation-conflict', 'unauthorized', 'invalid-content',
  'invalid-priority', 'invalid-reply', 'message-not-found', 'terminal-state',
  'unavailable', 'delivery-uncertain', 'unsupported', 'interjection',
]) satisfies z.ZodType<MessageReason>
const sender = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), sessionId: z.null() }),
  z.object({ kind: z.literal('session'), sessionId }),
])
const classification = z.discriminatedUnion('messageClass', [
  z.object({ messageClass: z.enum(['handoff', 'notice']), replyTo: z.never().optional() })
    .transform(({ messageClass }) => ({ messageClass })),
  z.object({ messageClass: z.literal('reply'), replyTo: messageId }),
])
const message = z.intersection(z.object({
  messageId, sender, senderSessionId: sessionId.nullable(),
  target: z.object({ nodeId, sessionId }), priority, content: z.string(),
  createdAt: integer, revision: integer, operationId, mailboxSequence: integer, stateVersion: integer,
}), classification).refine(value => value.senderSessionId === value.sender.sessionId)
const recipient = z.object({
  nodeId, sessionId, window: z.string().nullable(), title: z.string().nullable(),
  status: z.enum(['busy', 'idle', 'closed']), matchedFields: z.array(z.enum(['sessionId', 'window', 'title'])),
  observedAt: integer,
})
const sendResult = z.intersection(z.object({ messageId, operationId }), z.union([
  z.object({ deliveryOutcome: z.literal('accepted'), messageState: z.literal('queued'), pending: z.boolean(), recipient }),
  z.object({ deliveryOutcome: z.literal('rejected'), reason: z.literal('target-closed-pending'), messageState: z.literal('queued'), pending: z.literal(true), recipient }),
  z.object({ deliveryOutcome: z.literal('rejected'), reason: reason.exclude(['target-closed-pending']), messageState: z.literal('rejected'), pending: z.literal(false), candidates: z.array(recipient) }),
]))
const event = z.object({
  cursor: z.string().min(1).transform(value => value as MessageCursor), nodeId,
  data: z.object({
    messageId, senderSessionId: sessionId.nullable(), targetSessionId: sessionId.nullable(),
    priority, messageClass: z.enum(['handoff', 'notice', 'reply']), state, revision: integer,
    stateVersion: integer, operationId, observedAt: integer,
    transition: z.enum(['accepted', 'rejected', 'claimed', 'appended', 'rolled-back', 'injected', 'responded', 'withdrawn', 'edited', 'reprioritized', 'invalidated', 'delivery-uncertain']),
    reason: reason.optional(), firstRequestId: z.string().transform(value => value as NonNullable<MessageStateData['firstRequestId']>).optional(),
    firstTurnId: integer.optional(), deliveryOutcome: z.enum(['accepted', 'rejected']).optional(), pending: z.boolean().optional(),
  }).transform(({ reason, firstRequestId, firstTurnId, deliveryOutcome, pending, ...required }) => ({
    ...required,
    ...(reason === undefined ? {} : { reason }),
    ...(firstRequestId === undefined ? {} : { firstRequestId }),
    ...(firstTurnId === undefined ? {} : { firstTurnId }),
    ...(deliveryOutcome === undefined ? {} : { deliveryOutcome }),
    ...(pending === undefined ? {} : { pending }),
  })),
})
const status = z.object({
  messageId, state, phase: z.enum(['pending', 'claimed', 'appended', 'dispatched', 'settled', 'delivery-uncertain']),
  revision: integer, stateVersion: integer, transitions: z.array(event),
}).refine(value => value.transitions.every(item => item.data.messageId === value.messageId))
const control = z.intersection(z.object({ messageId, operationId, expectedRevision: integer, sender }),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('withdraw') }),
    z.object({ kind: z.literal('edit'), content: z.string() }),
    z.object({ kind: z.literal('reprioritize'), priority }),
    z.object({ kind: z.literal('invalidate'), reason: z.string() }),
  ]))
const controlResult = z.intersection(z.object({ messageId, operationId }), z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied'), status }),
  z.object({ kind: z.literal('accepted-pending-owner'), state: z.literal('queued'), revision: integer }),
  z.object({ kind: z.literal('rejected'), reason, status: status.nullable() }),
]))
const send = z.object({ kind: z.literal('send'), message, result: sendResult }).refine(value =>
  value.message.messageId === value.result.messageId && value.message.operationId === value.result.operationId
  && value.result.messageState === 'queued')
const decision = z.object({ message, status, events: z.array(event), notification: message.optional(), results: z.array(controlResult) })
  .refine(value => value.message.messageId === value.status.messageId
    && value.events.every(item => item.data.messageId === value.message.messageId))
  .transform(({ notification, ...required }) => ({ ...required, ...(notification === undefined ? {} : { notification }) }))

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new MailboxUnavailableError('Invalid durable mailbox evidence', { cause: result.error })
  return result.data
}

/** Validate an original sender-minted message.
 * @param value - durable JSON payload.
 * @returns message retaining its identity.
 */
export function decodeMessage(value: unknown): DeliveryMessage { return decode(message, value) }
/** Validate a sequenced send or control.
 * @param value - durable JSON payload.
 * @returns validated command.
 */
export function decodeCommand(value: unknown): SendCommand | ControlCommand { return decode(z.union([send, control]), value) }
/** Validate a complete status history.
 * @param value - durable JSON payload.
 * @returns validated status.
 */
export function decodeStatus(value: unknown): MessageStatus { return decode(status, value) }
/** Validate an atomic decision and invalidation outbox.
 * @param value - durable JSON payload.
 * @returns validated decision.
 */
export function decodeDecision(value: unknown): Decision { return decode(decision, value) }
/** Validate a retained receipt.
 * @param value - durable JSON payload.
 * @returns validated receipt.
 */
export function decodeReceipt(value: unknown): MessageStateEvent { return decode(event, value) }
/** Validate a retained sender acknowledgement.
 * @param value - durable JSON payload.
 * @returns validated acknowledgement.
 */
export function decodeSendResult(value: unknown): SendMessageResult { return decode(sendResult, value) }
/** Validate a retained control outcome.
 * @param value - durable JSON payload.
 * @returns validated control outcome.
 */
export function decodeControlResult(value: unknown): ControlResult { return decode(controlResult, value) }
