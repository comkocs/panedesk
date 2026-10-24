/** Entry-owned delegation issuance and receiving policy do not grant authority from wire strings. */
import type * as Seat from '@panedesk/dsh-seat'
import type { RoutedSendMessageRequest } from '@panedesk/dsh-message-delivery'
import type { NodeLinkFailure, NodeWireRequest } from './index.ts'

/** Identity-bearing messages reuse messages.send; no method or protocol number is added. */
export type NodeRoutedMessageRequest = Omit<Extract<NodeWireRequest, { method: 'messages.send' }>, 'payload'> & {
  payload: RoutedSendMessageRequest
}
/** Other operations retain their frozen request types and method/result correlation. */
export type NodePreparedRequest = Exclude<NodeWireRequest, { method: 'messages.send' }> | NodeRoutedMessageRequest
/** A sender prepares identity and digest before asking its trusted entry to issue delegation. */
export type NodeDelegationRequest = NodePreparedRequest extends infer Request
  ? Request extends NodePreparedRequest ? Omit<Request, 'delegation'> : never : never
/** Lifetime choices are explicit policy, not caller-selected privileges or implicit tunables. */
export interface NodeDelegationExpiryPolicy {
  readonly maxLifetimeMs: number
  readonly maxClockSkewMs: number
}
/** Issuance yields the unchanged wire delegation or an existing safe transport refusal. */
export type NodeDelegationResult =
  | { readonly status: 'issued'; readonly delegation: Seat.SeatNodeDelegation }
  | { readonly status: 'rejected'; readonly error: NodeLinkFailure }
/** Host entry captures original authority and signs or retains evidence bound to the exact method. */
export interface NodeDelegationIssuer {
  readonly expiry: NodeDelegationExpiryPolicy
  /** Verify live entry authority, binding, method and target before issuing a single-hop delegation.
   * Capture original kind through its trusted issuer, never principalId/origin string inference.
   * Bind method, payload digest, operation, source/target and call causality to retained evidence.
   * Expiry cannot exceed request.deadline, original authority expiry or configured lifetime;
   * skew never extends the signed deadline. Retry keeps identity/digest, not expired authority.
   * Missing issuer retains cross-node-unsupported or a safe authorization refusal before route().
   * @param request - Prepared request without caller-supplied delegation or role.
   * @returns Narrow delegation or refusal; authorizationRef is an audit reference, not a bearer.
   */
  issue(request: NodeDelegationRequest): Promise<NodeDelegationResult>
}
/** Verified connection evidence comes from the receiving transport, not the request payload. */
export interface NodeAuthenticatedPeer {
  readonly sourceNodeId: Seat.SeatNodeId
  readonly targetNodeId: Seat.SeatNodeId
  readonly authenticatedAt: Seat.SeatTimestamp
}
/** Each configured peer has an explicit local permission ceiling; SSH access alone grants none. */
export interface NodeReceivingPermissions {
  readonly sourceNodeId: Seat.SeatNodeId
  readonly targetNodeId: Seat.SeatNodeId
  readonly methods: readonly NodePreparedRequest['method'][]
  readonly policyRevision: number
}
/** Receiving policy intersects original rights, peer allowlist and current local target permissions. */
export interface NodeDelegationReceivingPolicy {
  readonly permissions: readonly NodeReceivingPermissions[]
  readonly expiry: NodeDelegationExpiryPolicy
  /** Validate authenticated peer, hop=1, local target, expiry, digest and retained issuer evidence.
   * Reject missing mappings and privilege amplification, including free-session write escalation.
   * Returned issuer is bound to this operation and locally records node-delegation attribution;
   * delegatedBy retains the sender's original authorization reference, not its local operator role.
   * @param request - Fully decoded request, including sender-frozen message identity when sending.
   * @param peer - Transport-owned node evidence; matching request strings are insufficient.
   * @returns Local exact-operation issuer or refusal, never permission for another routing hop.
   */
  authorize(request: NodePreparedRequest, peer: NodeAuthenticatedPeer): Promise<Seat.SeatAuthorizationIssuer | NodeLinkFailure>
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Optional entry-bound issuer; absence must not fabricate a delegation or enable routing. */
    nodeDelegationIssuer: NodeDelegationIssuer
    /** Optional receiving policy; absence refuses ingress rather than trusting a remote role. */
    nodeDelegationReceivingPolicy: NodeDelegationReceivingPolicy
  }
}
