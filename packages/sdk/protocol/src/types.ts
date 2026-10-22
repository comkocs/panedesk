/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: its
 * request/result pairs and server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@panedesk/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @panedesk/dsh-sdk-protocol/types
 */

import type { ContentBlock, LlmCacheControl, ReasoningEffortId } from '@panedesk/dsh-llm'
import type { SessionEvent } from '@panedesk/dsh-session'
import type { SubagentStopReason } from '@panedesk/dsh-subagent'
import type { MessageId } from '@panedesk/dsh-llm/brand'
import type {
  ConfigureMessagesRequest, ControlResult, EditMessageRequest, InvalidateMessageRequest,
  MessageAddress, MessageControlRequest, MessageCursor, MessagePage, MessageQuery, MessageSettings,
  MessageStateEvent, MessageStatus, MessageSubscriptionRequest, OperationId, OperationStatus,
  ReprioritizeMessageRequest, ResolvedRecipient, SendBatchRequest, SendBatchResult,
  SendMessageRequest, SendMessageResult,
} from '@panedesk/dsh-message-delivery'

/** Message receipt stream admission; notifications resume strictly after the supplied cursor. */
export interface MessagesSubscribeResult {
  readonly cursor?: MessageCursor
}

/** Message requests share provider validation; sender authority comes from the authenticated connection. */
export interface MessagesRequestMap {
  'messages/send': { params: SendMessageRequest; result: SendMessageResult }
  'messages/withdraw': { params: MessageControlRequest; result: ControlResult }
  'messages/edit': { params: EditMessageRequest; result: ControlResult }
  'messages/reprioritize': { params: ReprioritizeMessageRequest; result: ControlResult }
  'messages/invalidate': { params: InvalidateMessageRequest; result: ControlResult }
  'messages/status': { params: { readonly messageId: MessageId }; result: MessageStatus }
  'messages/operationStatus': { params: { readonly operationId: OperationId }; result: OperationStatus }
  'messages/list': { params: MessageQuery; result: MessagePage }
  'messages/resolve': { params: { readonly addresses: readonly MessageAddress[] }; result: readonly ResolvedRecipient[] }
  'messages/sendBatch': { params: SendBatchRequest; result: SendBatchResult }
  'messages/configure': { params: ConfigureMessagesRequest; result: MessageSettings }
  'messages/subscribe': { params: MessageSubscriptionRequest; result: MessagesSubscribeResult }
}

/** Expected installed preset version; the server must resolve local policy rather than trust client authority. */
export interface InitializeExecutionPolicy {
  presetId: string
  version: string
  digest: string
}

/** Non-sensitive inherited attribution and parent/child linkage; never written into the Session header. */
export interface InitializeLedgerContext {
  seat: string
  window: string
  taskId?: string
  nodeId: string
  identitySource: 'startup' | 'environment' | 'settings' | 'inherited' | 'free'
  parentSessionId: string
  rootSessionId: string
  subagentRunId: string
  parentRunId: string
  /** Parent-reserved child id, explicitly mapped to the child's actual Session id. */
  childSessionId: string
  accountLabel?: string
  deliveryPaths?: readonly string[]
}

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Message extension version understood by the client; omission preserves the original handshake. */
  messagesVersion?: number
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
  /** Installed controlled preset; omission preserves the existing handshake. */
  agentPreset?: string
  /** Expected installed policy; mismatch or absence of the named local definition rejects initialization. */
  executionPolicy?: InitializeExecutionPolicy
  /** Inherited ledger attribution; omission resolves local configured identity or free. */
  ledgerContext?: InitializeLedgerContext
  /** Session cache controls; omission resolves the local session policy. */
  cachePolicy?: LlmCacheControl
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Negotiated message extension version; absent when delivery is unavailable. */
  messagesVersion?: number
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: SdkPromptContentBlock[]
}

/** Inline raster input admitted into the runtime's durable attachment store. */
export interface SdkEncodedImageBlock {
  type: 'image'
  /** Canonical base64-encoded raster bytes. */
  data: string
  /** Declared raster MIME type, verified during admission. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** SDK prompt input: ordinary durable blocks plus inline images awaiting admission. */
export type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Restore a persisted session without enqueueing a prompt. */
export interface SessionResumeParams {
  /** Persisted session identity; missing or already owned sessions are rejected. */
  sessionId: string
}

/** Wait for an existing SDK session and its managed descendants to finish. */
export interface SessionWaitParams {
  /** An SDK-owned session id; waiting never creates a session. */
  sessionId: string
}

/** Session whose effective working directory is requested; an unknown id creates the Session. */
export interface SessionWorkingDirectoryParams {
  /** SDK-side Session identity. */
  sessionId: string
}

/** Change one Session's effective directory without changing its origin or permissions. */
export interface SessionWorkingDirectorySetParams extends SessionWorkingDirectoryParams {
  /** Directory to enter; relative paths resolve against the Session's current directory. */
  path: string
}

/** Validated effective directory after a read, change, or missing-directory recovery. */
export interface SessionWorkingDirectoryResult {
  /** Absolute directory used by future independent operations and new processes. */
  cwd: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'messages.state': MessageStateEvent
  /** Receipt stream terminated; resume from the last consumed cursor after restoring availability. */
  'messages.error': { readonly sessionId: MessageSubscriptionRequest['sessionId']; readonly reason: 'unavailable' }
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap extends MessagesRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/resume': { params: SessionResumeParams; result: Record<string, never> }
  'session/wait': { params: SessionWaitParams; result: Record<string, never> }
  'session/working-directory/get': { params: SessionWorkingDirectoryParams; result: SessionWorkingDirectoryResult }
  'session/working-directory/set': { params: SessionWorkingDirectorySetParams; result: SessionWorkingDirectoryResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
