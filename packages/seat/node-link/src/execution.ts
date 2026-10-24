/** Receiving adapters compose local providers with trusted attribution and atomic admission. */
import type * as Seat from '@panedesk/dsh-seat'
import type { RoutedDeliveryAuthorizer, RoutedMessageReceiver } from '@panedesk/dsh-message-delivery'
import type { NodeLinkExecutor, NodeWireResponse } from './index.ts'
import type { NodePreparedRequest } from './delegation.ts'

/** Local admission is explicitly supplied by the journal-owning provider, never synthesized by transport. */
export interface NodeAuthorizedLocalAdmission {
  /** Commit the exact grant with the original action intent before dispatching local effects.
   * @param request - Single-hop operation already checked against the local target.
   * @param authorization - Entry-issued, process-local grant with exact operation evidence.
   * @returns Correlated local result after atomic admission; no rerouting is permitted.
   */
  execute(request: NodePreparedRequest, authorization: Seat.SeatAuthorizationGrant): Promise<NodeWireResponse>
}
import type { NodeAuthenticatedPeer, NodeDelegationReceivingPolicy } from './delegation.ts'

declare module '@panedesk/cordis' {
  interface Context {
    /** Local journal-owning admission, installed only by the seat provider. */
    nodeAuthorizedLocalAdmission: NodeAuthorizedLocalAdmission
  }
}

/** The host supplies local-only capabilities; no router is available through this interface. */
export interface NodeLinkExecutionDependencies {
  readonly nodeId: Seat.SeatNodeId
  readonly peer: NodeAuthenticatedPeer
  readonly policy: NodeDelegationReceivingPolicy
  readonly authorization: Seat.SeatAuthorizationTransactions
  readonly localSeats: Seat.SeatService
  readonly messages?: RoutedMessageReceiver
  readonly messageAuthority?: RoutedDeliveryAuthorizer
  /** Optional local admission owner that commits the grant and action together; absence refuses seat writes. */
  readonly localAdmission?: NodeAuthorizedLocalAdmission
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
