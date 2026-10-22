/** Service Definition for same-node messages; the local provider owns delivery and durable arbitration. */
import { Context, Service } from '@panedesk/cordis'
import type { MessageId } from '@panedesk/dsh-llm/brand'
import type {
  ConfigureMessagesRequest, ControlResult, EditMessageRequest, InvalidateMessageRequest,
  MessageAddress, MessageControlRequest, MessagePage, MessageQuery, MessageSettings,
  MessageStateEvent, MessageStatus, MessageSubscriptionRequest, OperationId, OperationStatus,
  ReprioritizeMessageRequest, ResolvedRecipient, SendBatchRequest, SendBatchResult,
  SendMessageRequest, SendMessageResult,
} from './types.ts'
export type * from './events.ts'

export type * from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    messageDelivery: MessageDelivery
  }
}

/** Caller authority is bound by the provider; wire input never supplies trusted sender identity. */
export abstract class MessageDelivery extends Service {
  constructor(ctx: Context) {
    super(ctx, 'messageDelivery')
  }

  /**
   * Publish one message without waiting for model execution.
   * @param request - address, classification, content, and idempotency identity.
   * @returns delivery acknowledgement distinct from lifecycle state.
   */
  abstract send(request: SendMessageRequest): Promise<SendMessageResult>
  /**
   * Request withdrawal before claim; an offline owner acknowledges only durable intent.
   * @param request - message identity, expected revision, and operation identity.
   * @returns owner decision or pending-owner acknowledgement.
   */
  abstract withdraw(request: MessageControlRequest): Promise<ControlResult>
  /**
   * Replace unclaimed content without replacing its identity or FIFO position.
   * @param request - revision-checked replacement text.
   * @returns owner decision or pending-owner acknowledgement.
   */
  abstract edit(request: EditMessageRequest): Promise<ControlResult>
  /**
   * Move unclaimed input to the new priority's FIFO tail.
   * @param request - revision-checked effective priority.
   * @returns owner decision or pending-owner acknowledgement.
   */
  abstract reprioritize(request: ReprioritizeMessageRequest): Promise<ControlResult>
  /**
   * Withdraw queued input or preserve injected history and publish an invalidation notice.
   * @param request - message identity and human-readable invalidation reason.
   * @returns owner decision or pending-owner acknowledgement.
   */
  abstract invalidate(request: InvalidateMessageRequest): Promise<ControlResult>
  /**
   * Read runtime-owned history; a missing identity rejects rather than fabricating state.
   * @param messageId - sender-minted business identity.
   * @returns current state and retained transition timestamps.
   */
  abstract status(messageId: MessageId): Promise<MessageStatus>
  /**
   * Observe durable control settlement without resubmitting the command.
   * @param operationId - caller-retained control identity.
   * @returns explicit missing, pending, or settled outcome.
   */
  abstract operationStatus(operationId: OperationId): Promise<OperationStatus>
  /**
   * Query messages without treating missing evidence as an empty complete result.
   * @param query - filters and bounded cursor pagination.
   * @returns status page with storage completeness.
   */
  abstract list(query: MessageQuery): Promise<MessagePage>
  /**
   * Resolve exact addresses without publishing messages or opening Sessions.
   * @param addresses - explicit local addresses, without wildcard expansion.
   * @returns candidates or exact recipients with observation times.
   */
  abstract resolve(addresses: readonly MessageAddress[]): Promise<ResolvedRecipient[]>
  /**
   * Resolve or publish an explicit recipient list, deduplicated by Session identity.
   * @param request - independent recipient operation identities and dry-run selection.
   * @returns dry-run resolutions or independent delivery outcomes.
   */
  abstract sendBatch(request: SendBatchRequest): Promise<SendBatchResult>
  /**
   * Persist receive policy without retroactively dropping accepted input.
   * @param request - complete policy for an authorized Session.
   * @returns the committed settings.
   */
  abstract configure(request: ConfigureMessagesRequest): Promise<MessageSettings>
  /**
   * Replay and watch receipts; iterator return or service disposal releases the subscription.
   * Subscription never wakes a Session or emits model-authored receipt claims.
   * @param request - authorized Session and exclusive resume cursor.
   * @returns ordered runtime-owned state events; storage failures reject iteration.
   */
  abstract subscribe(request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent>
}

export default MessageDelivery
