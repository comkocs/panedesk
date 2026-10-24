/**
 * TypeScript client SDK for the DeepSeek Harness runtime: spawn the
 * same-version `panedesk --profile sdk` runtime as a subprocess and drive agent
 * turns over stdio JSON-RPC. `DeepSeekHarness` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; named profiles and ordered patch
 * files customize the runtime process it spawns.
 *
 * @module @panedesk/dsh-sdk-client
 */

export { DeepSeekHarness, HarnessSession, validatedSessionEvent } from './api.ts'
export { SeatsClient } from './seats.ts'
export { HostClient } from './host.ts'
export type { HostQueryMethods, SdkNamespaceCapability } from './host.ts'
export type { SeatRequestMap } from '@panedesk/dsh-sdk-protocol'
export type { RunOptions, SessionSendMessageRequest } from './api.ts'
export type {
  MessagesRequestMap, MessagesSubscribeResult, SendMessageRequest, SendMessageResult,
  MessageControlRequest, EditMessageRequest, ReprioritizeMessageRequest, InvalidateMessageRequest,
  ControlResult, MessageStatus, OperationStatus, OperationId, MessageQuery, MessagePage,
  MessageAddress, ResolvedRecipient, SendBatchRequest, SendBatchResult, ConfigureMessagesRequest,
  MessageSettings, MessageSubscriptionRequest, MessageStateEvent, MessageCursor,
} from '@panedesk/dsh-sdk-protocol'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@panedesk/dsh-sdk-protocol'
export type {
  ContentBlock,
  SdkPromptContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
