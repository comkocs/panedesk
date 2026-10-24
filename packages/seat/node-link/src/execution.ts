/** Receiving adapters compose local providers with trusted attribution and atomic admission. */
import type * as Seat from '@panedesk/dsh-seat'
import type { RoutedDeliveryAuthorizer, RoutedMessageReceiver } from '@panedesk/dsh-message-delivery'
import type { NodeLinkExecutor } from './index.ts'
import type { NodeAuthenticatedPeer, NodeDelegationReceivingPolicy } from './delegation.ts'

/** The host supplies local-only capabilities; no router is available through this interface. */
export interface NodeLinkExecutionDependencies {
  readonly nodeId: Seat.SeatNodeId
  readonly peer: NodeAuthenticatedPeer
  readonly policy: NodeDelegationReceivingPolicy
  readonly authorization: Seat.SeatAuthorizationTransactions
  readonly localSeats: Seat.SeatService
  readonly messages?: RoutedMessageReceiver
  readonly messageAuthority?: RoutedDeliveryAuthorizer
}
/** Implementations are installed explicitly as nodeLinkExecutor, never by importing declarations. */
export interface NodeLinkExecutionAdapter {
  /** Adapt existing fixed methods without duplicating local approval, gates, budgets or admission.
   * authorize() must check current policy on every delivery, including retries; execute() must
   * recheck the exact operation and commit issued authorization with its local action intent.
   * Only after durable admission may local effects run. Transport OperationStore is not an audit
   * transaction. Failed or absent authorization persistence must never call an unaudited provider.
   * Receiving calls target this node with hop=1; no local provider may route them onward.
   * messages.send requires the identity-bearing payload and both trusted message capabilities;
   * missing capabilities reject cross-node-unsupported, never fall back to ordinary send().
   * @param dependencies - Host-owned local providers, receiving policy and journal capability.
   * @returns Existing executor interface; missing adapter leaves ingress refusing as before.
   */
  create(dependencies: NodeLinkExecutionDependencies): NodeLinkExecutor
}
