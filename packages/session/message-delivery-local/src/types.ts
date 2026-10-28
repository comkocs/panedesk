/** Local provider state, kept outside Session persistence declarations. */
import type { Agent, AgentInputScheduler } from '@panedesk/dsh-agent'
import type { MessageId, UserMessage } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import type {
  ControlResult, DeliveryMessage, MessagePriority, MessageSender, MessageSettings, MessageStateEvent,
  MessageStatus, SendMessageResult,
} from '@panedesk/dsh-message-delivery'

/** Required deployment limits are resolved at plugin activation. */
export interface Config {
  /** Harness home containing the private mailbox; omission uses the resolved application home. */
  readonly dshHome?: string
  /** Explicit local identity; omission resolves the persisted Session ledger node at startup. */
  readonly nodeId?: string
  /** Maximum encoded bytes accepted for one mailbox record. */
  readonly maxRecordBytes: number
  /** Maximum UTF-8 bytes accepted for sent or edited message content. */
  readonly maxContentBytes: number
  /** Maximum recipients per batch and default message query page size. */
  readonly maxBatchSize: number
  /** Mailbox and receipt scan interval in milliseconds, at most one second. */
  readonly scanIntervalMs: number
  /** Maximum time in milliseconds to acquire a mailbox lock. */
  readonly lockTimeoutMs: number
  /** Delay in milliseconds between mailbox lock acquisition attempts. */
  readonly lockRetryMs: number
  /** Enable filesystem notifications in addition to periodic mailbox scans. */
  readonly watch: boolean
  /** Enable explicit same-node seat queries; omission or false preserves legacy addressing only. */
  readonly seatAddressing?: boolean
}

/** Exact runtime adapter; queue mutation belongs to the priority-aware driver. */
export interface DeliveryDriver extends AgentInputScheduler {
  readonly agent: Agent
  /** Apply a control through the same queue mutation entry used by interactive callers. */
  mutate(messageId: MessageId, action: { kind: 'remove' } | { kind: 'edit'; message: UserMessage } | { kind: 'reprioritize'; priority: MessagePriority }): boolean
}

/** Read-only metadata obtained from Session projections and runtime registrations. */
export interface RecipientMetadata {
  readonly sessionId: SessionId
  readonly title: string | null
  readonly window: string | null
  readonly archived: boolean
  readonly settings: MessageSettings
}

/** Persisted send intent and sender acknowledgement. */
export interface SendCommand {
  readonly kind: 'send'
  readonly message: DeliveryMessage
  readonly result: SendMessageResult
}

/** Durable controls share the send sequence and never mutate a foreign queue. */
export type ControlCommand = {
  readonly messageId: MessageId
  readonly operationId: import('@panedesk/dsh-message-delivery').OperationId
  readonly expectedRevision: number
  readonly sender: MessageSender
} & (
  | { readonly kind: 'withdraw' }
  | { readonly kind: 'edit'; readonly content: string }
  | { readonly kind: 'reprioritize'; readonly priority: MessagePriority }
  | { readonly kind: 'invalidate'; readonly reason: string }
)

/** Atomic owner decision includes the invalidation outbox in the same file. */
export interface Decision {
  readonly message: DeliveryMessage
  readonly status: MessageStatus
  readonly events: readonly MessageStateEvent[]
  readonly notification?: DeliveryMessage
  readonly results: readonly ControlResult[]
}
