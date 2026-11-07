/** Exact seat messages retain sender identity before the target resolves its local window. */
import type { DeliveryMessage, MessageReason, NodeId, OnlineSeat, OperationId, SendMessageRequest, SendMessageResult } from './types.ts'
import type { RoutedDeliveryEnvelope, RoutedDeliveryAuthority } from './routed.ts'

/** One exact seat on one node; no title matching or wildcard expansion. */
export interface SeatMessageAddress {
  readonly nodeId: NodeId
  readonly seat: string
}
/** Caller identity is captured by the provider, never selected by tool arguments. */
export type SendSeatMessageRequest = import('./types.ts').MessageClassification & Omit<SendMessageRequest, 'target'> & { readonly target: SeatMessageAddress }
/** Target resolution may replace only the address when committing the original message. */
export type SeatDeliveryEnvelope = Omit<RoutedDeliveryEnvelope, 'message'> & {
  readonly message: import('./types.ts').MessageClassification & Omit<DeliveryMessage, 'target'> & { readonly target: SeatMessageAddress }
}
/** All outer fields must match the frozen envelope. */
export type RoutedSeatMessageRequest = SendSeatMessageRequest & { readonly delivery: SeatDeliveryEnvelope }
/** Read-only query identity is not a mailbox reservation. */
export interface OnlineSeatsRequest { readonly operationId: OperationId }
/** Each node reports an explicit observation or unknown, never an invented empty snapshot. */
export type SeatNodeObservation =
  | { readonly nodeId: NodeId; readonly state: 'observed'; readonly seats: readonly OnlineSeat[] }
  | { readonly nodeId: NodeId; readonly state: 'unknown'; readonly reason: MessageReason }
/** Host-authenticated ingress does not route again or create a replacement sender. */
export interface RoutedSeatMessageReceiver {
  /** Commit original identities after checking local receive policy.
   * @param request - Sender-frozen seat target and message.
   * @param authority - Optional legacy host metadata; delivery does not require authorization.
   * @returns Durable original acknowledgement or safe refusal.
   */
  receive(request: RoutedSeatMessageRequest, authority?: RoutedDeliveryAuthority): Promise<SendMessageResult>
  /** Observe only this node's verified windows without reserving delivery.
   * @returns Current local busy and idle windows.
   */
  online(): Promise<readonly OnlineSeat[]>
}
declare module '@panedesk/cordis' {
  interface Context { routedSeatMessageReceiver: RoutedSeatMessageReceiver }
}
