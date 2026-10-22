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
  readonly dshHome?: string
  readonly nodeId: string
  readonly maxRecordBytes: number
  readonly maxContentBytes: number
  readonly maxBatchSize: number
  readonly scanIntervalMs: number
  readonly lockTimeoutMs: number
  readonly lockRetryMs: number
  readonly watch: boolean
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
