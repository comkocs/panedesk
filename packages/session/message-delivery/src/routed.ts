/** Routed delivery preserves sender-minted identity without exposing a public sender override. */
import type { Branded } from '@panedesk/dsh-brand'
import type { DeliveryMessage, NodeId, SendMessageRequest, SendMessageResult } from './types.ts'

/** Sanitized original routing refusal; diagnostic codes are bounded ASCII identifiers. */
export interface RoutedDeliveryFailureCause {
  readonly domain: string
  readonly code: string
  readonly reason: string
  readonly effectState: 'none' | 'committed' | 'partial' | 'unknown'
  readonly retryable: boolean
  readonly operationId: SendMessageRequest['operationId']
  readonly nodeId: NodeId
  readonly reasonCode?: string
}

/** Stable transport identity is distinct from the business message and operation identities. */
export type RoutedDeliveryId = Branded<'RoutedDeliveryId'>
/** SHA-256 of the canonical complete envelope, excluding this digest field. */
export type RoutedDeliveryDigest = Branded<'RoutedDeliveryDigest'>
/** Frozen causal evidence travels with the message; absent tool evidence is not synthesized. */
export interface RoutedDeliveryEnvelope {
  readonly message: DeliveryMessage
  readonly deliveryId: RoutedDeliveryId
  readonly sourceNodeId: NodeId
  readonly digest: RoutedDeliveryDigest
  readonly callId?: Branded<'ToolCallId'>
  readonly rootCallId?: Branded<'ToolCallId'>
  readonly causedByDeliveryId?: RoutedDeliveryId
}
/** Legacy request fields must equal the frozen message; neither representation overrides the other. */
export type RoutedSendMessageRequest = SendMessageRequest & {
  readonly delivery: RoutedDeliveryEnvelope
}

declare const trustedDeliveryAuthority: unique symbol
/** Host-owned authorization evidence is process-local, never decoded from a wire object. */
export interface RoutedDeliveryAuthority {
  readonly [trustedDeliveryAuthority]: true
  readonly sourceNodeId: NodeId
  readonly targetNodeId: NodeId
}
/** Authentication adapters bind exact envelopes after checking current node and sender permissions. */
export interface RoutedDeliveryAuthorizer {
  /** Bind verified peer, live sender evidence, target, operation, digest and single-hop permission.
   * Implementations capture authenticated transport authority rather than accepting caller roles.
   * @param envelope - Validated frozen identity and payload; strings alone never authorize it.
   * @returns Process-local authority or null; absence never falls back to ordinary send.
   */
  authorize(envelope: RoutedDeliveryEnvelope | import('./seat-messages.ts').SeatDeliveryEnvelope): Promise<RoutedDeliveryAuthority | null>
}
/** This optional receiver never mints a replacement message, delivery, operation or causal identity. */
export interface RoutedMessageReceiver {
  /** Durably commit the original message plus deduplication result before ack.
   * Compare all request fields with delivery.message and verify the canonical envelope digest.
   * Same source/message/delivery/operation identity and digest returns the original durable ack;
   * reusing any retained identity with different content or causal evidence rejects operation-conflict.
   * Preserve sender, priority, replyTo and timestamps; only target-owned mailbox/state sequences
   * may advance during local admission. Accepted does not imply injection or a model response.
   * Call only the local mailbox provider, never send(), a router or another node. Hop is one.
   * Storage failure cannot yield accepted; unknown durability requires reconciliation before retry.
   * @param request - Sender-frozen message, transport identity, digest and matching legacy fields.
   * @param authority - Optional legacy host metadata; delivery does not require authorization.
   * @returns Original correlated acknowledgement after durable admission, or the existing refusal.
   */
  receive(request: RoutedSendMessageRequest, authority?: RoutedDeliveryAuthority): Promise<SendMessageResult>
}

/** The authority owner verifies identity rather than trusting a structurally similar object. */
export interface RoutedDeliveryVerifier {
  /** Recheck an exact envelope against the host's process-local capability registry.
   * @param authority - Previously issued host capability.
   * @param envelope - Exact sender-frozen delivery and causal evidence.
   * @returns Whether the capability belongs to this live host and envelope.
   */
  verify(authority: RoutedDeliveryAuthority, envelope: RoutedDeliveryEnvelope | import('./seat-messages.ts').SeatDeliveryEnvelope): Promise<boolean>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Missing capability retains cross-node-unsupported; ordinary local send remains unchanged. */
    routedMessageReceiver: RoutedMessageReceiver
    /** Optional exact-envelope verifier; missing ownership keeps routed ingress disabled. */
    routedDeliveryVerifier: RoutedDeliveryVerifier
  }
}
