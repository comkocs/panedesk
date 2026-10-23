/** Same-node message delivery, durable controls, and runtime-owned receipts. */
import type { Branded } from '@panedesk/dsh-brand'
import type { MessageId } from '@panedesk/dsh-llm/brand'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { InputPriority } from '@panedesk/dsh-agent/types'

/** Stable node identity; not a network address. */
export type NodeId = Branded<'LedgerNodeId'>
/** Caller-retained idempotency identity; reuse with different input is rejected. */
export type OperationId = Branded<'MessageOperationId'>
/** Durable receipt cursor, independent of Session event positions. */
export type MessageCursor = Branded<'MessageCursor'>
/** Effective priority; new sends default to steer, notices resolve to queue. */
export type MessagePriority = InputPriority
/** Reply requires an original message identity and has handoff wake semantics. */
export type MessageClass = 'handoff' | 'notice' | 'reply'
/** Runtime-owned public state; claim is a separate internal phase. */
export type MessageState = 'queued' | 'injected' | 'responded' | 'withdrawn' | 'invalidated' | 'rejected'
/** Delivery acknowledgement is independent of the message's lifecycle state. */
export type DeliveryOutcome = 'accepted' | 'rejected'
/** Runtime availability, never inferred from a recipient's name. */
export type RecipientStatus = 'busy' | 'idle' | 'closed'
/** Structured refusal or pending cause; presentation belongs to consumers. */
export type MessageReason =
  | 'target-closed-pending' | 'target-archived' | 'target-not-found' | 'target-ambiguous'
  | 'receive-disabled' | 'handoff-only' | 'cross-node-unsupported' | 'claimed' | 'injected'
  | 'revision-conflict' | 'operation-conflict' | 'unauthorized' | 'invalid-content'
  | 'invalid-priority' | 'invalid-reply' | 'message-not-found' | 'terminal-state'
  | 'unavailable' | 'delivery-uncertain' | 'unsupported' | 'interjection' | 'record-corrupt'

/** Isolated mailbox evidence; message identity is omitted when it cannot be recovered. */
export interface MessageQuarantineData {
  readonly messageId?: MessageId
  readonly reason: 'corrupt' | 'unsupported-version' | 'invalid-fields'
  readonly originalFileName: string
}
/** Auditable transition, including reservation and rollback without a public state change. */
export type MessageTransition = 'accepted' | 'rejected' | 'claimed' | 'appended' | 'rolled-back'
  | 'injected' | 'responded' | 'withdrawn' | 'edited' | 'reprioritized' | 'invalidated' | 'delivery-uncertain'
/** Exact address; omitted node means this node, with no cross-node fallback. */
export type MessageAddress =
  | { readonly nodeId?: NodeId; readonly sessionId: SessionId; readonly name?: never }
  | { readonly nodeId?: NodeId; readonly name: string; readonly sessionId?: never }
/** Authenticated origin; a human command does not fabricate a Session or run. */
export type MessageSender =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'human'; readonly sessionId: null }
/** One candidate, with both name fields considered and deduplicated by Session identity. */
export interface MessageRecipient {
  readonly nodeId: NodeId
  readonly sessionId: SessionId
  readonly window: string | null
  readonly title: string | null
  readonly status: RecipientStatus
  readonly matchedFields: readonly ('sessionId' | 'window' | 'title')[]
  readonly observedAt: number
}
/** Resolution never opens a Session or publishes a mailbox record. */
export type ResolvedRecipient =
  | { readonly kind: 'resolved'; readonly address: MessageAddress; readonly recipient: MessageRecipient }
  | { readonly kind: 'rejected'; readonly address: MessageAddress; readonly reason: MessageReason; readonly candidates: readonly MessageRecipient[] }
/** Per-Session receive policy; replies qualify under handoff-only. */
export interface MessageSettings {
  readonly receiveMode: 'all' | 'handoff-only' | 'none'
  readonly wakeOnHandoff: boolean
}
/** Class-specific reply association; non-replies cannot impersonate replies. */
export type MessageClassification =
  | { readonly messageClass: 'handoff' | 'notice'; readonly replyTo?: never }
  | { readonly messageClass: 'reply'; readonly replyTo: MessageId }
/** Send input; caller identity comes from invocation context, never a wire-supplied sender. */
export type SendMessageRequest = MessageClassification & {
  readonly target: MessageAddress
  readonly content: string
  /** Omission resolves to steer for handoff/reply and queue for notice; explicit non-queue notices are rejected. */
  readonly priority?: MessagePriority
  readonly operationId: OperationId
}
/** Persisted message; the sender mints its identity and the target never replaces it. */
export type DeliveryMessage = MessageClassification & {
  readonly messageId: MessageId
  readonly sender: MessageSender
  readonly senderSessionId: SessionId | null
  readonly target: { readonly nodeId: NodeId; readonly sessionId: SessionId }
  readonly priority: MessagePriority
  readonly content: string
  readonly createdAt: number
  readonly revision: number
  readonly operationId: OperationId
  readonly mailboxSequence: number
  readonly stateVersion: number
}
/** One runtime-observed state fact; text authored by a model cannot produce this event. */
export interface MessageStateData {
  readonly messageId: MessageId
  readonly senderSessionId: SessionId | null
  readonly targetSessionId: SessionId | null
  readonly priority: MessagePriority
  readonly messageClass: MessageClass
  readonly state: MessageState
  readonly revision: number
  readonly stateVersion: number
  readonly operationId: OperationId
  readonly transition: MessageTransition
  readonly observedAt: number
  readonly reason?: MessageReason
  readonly firstRequestId?: Branded<'InputRequestId'>
  readonly firstTurnId?: number
  readonly deliveryOutcome?: DeliveryOutcome
  readonly pending?: boolean
}
/** Receipt notification; subscription replay resumes after cursor and never wakes the sender. */
export interface MessageStateEvent {
  readonly cursor: MessageCursor
  readonly nodeId: NodeId
  readonly data: MessageStateData
}
/** Complete status with first-injection time preserved even when response attribution moves to a later successful turn. */
export interface MessageStatus {
  readonly messageId: MessageId
  readonly state: MessageState
  readonly phase: 'pending' | 'claimed' | 'appended' | 'dispatched' | 'settled' | 'delivery-uncertain'
  readonly revision: number
  readonly stateVersion: number
  readonly transitions: readonly MessageStateEvent[]
}
/** Send result; a closed target is rejected for delivery but retains a queued pending message. */
export type SendMessageResult = {
  readonly messageId: MessageId
  readonly operationId: OperationId
} & (
  | { readonly deliveryOutcome: 'accepted'; readonly messageState: 'queued'; readonly pending: boolean; readonly recipient: MessageRecipient }
  | { readonly deliveryOutcome: 'rejected'; readonly reason: 'target-closed-pending'; readonly messageState: 'queued'; readonly pending: true; readonly recipient: MessageRecipient }
  | { readonly deliveryOutcome: 'rejected'; readonly reason: Exclude<MessageReason, 'target-closed-pending'>; readonly messageState: 'rejected'; readonly pending: false; readonly candidates: readonly MessageRecipient[] }
)
/** Control submitted to the target owner in mailbox order, never applied by the sending process. */
export interface MessageControlRequest {
  readonly messageId: MessageId
  readonly operationId: OperationId
  readonly expectedRevision: number
}
/** Text-only replacement preserving message identity and enqueue order. */
export interface EditMessageRequest extends MessageControlRequest {
  readonly content: string
}
/** Priority changes enter the new priority's FIFO tail after owner arbitration. */
export interface ReprioritizeMessageRequest extends MessageControlRequest {
  readonly priority: MessagePriority
}
/** Invalidating injected input retains history and durably queues a separate notification. */
export interface InvalidateMessageRequest extends MessageControlRequest {
  readonly reason: string
}
/** An accepted offline control is durable intent, not a successful withdrawal. */
export type ControlResult = {
  readonly operationId: OperationId
  readonly messageId: MessageId
} & (
  | { readonly kind: 'applied'; readonly status: MessageStatus }
  | { readonly kind: 'accepted-pending-owner'; readonly state: 'queued'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly reason: MessageReason; readonly status: MessageStatus | null }
)
/** Durable control observation; unknown operations remain distinct from pending operations. */
export type OperationStatus =
  | { readonly kind: 'not-found'; readonly operationId: OperationId }
  | ControlResult
/** Half-open time filter; unanswered selects handoff/reply without response and excludes terminal outcomes by default. */
export interface MessageQuery {
  readonly sessionId?: SessionId
  readonly senderSessionId?: SessionId
  readonly targetSessionId?: SessionId
  readonly nodeId?: NodeId
  readonly from?: number
  readonly to?: number
  readonly states?: readonly MessageState[]
  readonly messageClasses?: readonly MessageClass[]
  readonly unansweredOlderThanMinutes?: number
  readonly includeTerminal?: boolean
  /** Opt into strict cursor pagination; omission preserves the provider's legacy list behavior. */
  readonly pagination?: boolean
  /** Provider-issued exclusive continuation when pagination is enabled; retain the same filters. */
  readonly cursor?: MessageCursor
  /** Page size; strict pagination requires a positive safe integer. Omission uses the provider's configured limit. */
  readonly limit?: number
}
/** Incomplete storage scans are visible and never masquerade as an empty complete result. */
export interface MessagePage {
  readonly items: readonly MessageStatus[]
  readonly complete: boolean
  readonly nextCursor?: MessageCursor
}
/** Explicit recipient list; dry run resolves without minting or delivering messages. */
export type SendBatchRequest = MessageClassification & {
  readonly content: string
  readonly priority?: MessagePriority
  readonly recipients: readonly { readonly target: MessageAddress; readonly operationId: OperationId }[]
  readonly dryRun: boolean
}
/** Every unique resolved Session has an independent send outcome; no whole-batch transaction is promised. */
export type SendBatchResult =
  | { readonly kind: 'resolved'; readonly recipients: readonly ResolvedRecipient[] }
  | { readonly kind: 'sent'; readonly results: readonly SendMessageResult[] }
/** Complete policy replacement; omission is not an implicit reset. */
export interface ConfigureMessagesRequest {
  readonly sessionId: SessionId
  readonly settings: MessageSettings
}
/** Receipt replay resumes strictly after cursor; omission starts with currently retained receipts. */
export interface MessageSubscriptionRequest {
  readonly sessionId: SessionId
  readonly cursor?: MessageCursor
}

declare module '@panedesk/dsh-llm' {
  interface MessageSourceMap {
    /** Business identity stays in source metadata, not the generic user message. */
    'message-delivery': MessageClassification & {
      readonly kind: 'message-delivery'
      readonly senderSessionId: SessionId | null
      readonly operationId: OperationId
      readonly relatedMessageId?: MessageId
    }
  }
}
