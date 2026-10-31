/** Delegations retain exact request evidence; audit references alone never authorize ingress. */
import type * as Seat from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-host-admin'
import type { NodeDelegationIssuer, NodeDelegationRequest, NodeDelegationExpiryPolicy,
  NodeDelegationReceivingPolicy, NodePreparedRequest, NodeReceivingPermissions } from './delegation.ts'
import type { NodeLinkFailure } from './index.ts'

/** A trusted host retains this evidence independently of the wire's claimed role. */
export interface DelegationEvidence {
  readonly request: NodeDelegationRequest
  readonly delegation: Seat.SeatNodeDelegation
  readonly original: Readonly<Seat.SeatIssuedAuthorizationFact>
}
/** Issuer dependencies are captured at the authenticated entry, never decoded from a request. */
export interface DelegationIssuanceOptions {
  readonly issuer: Seat.SeatAuthorizationIssuer
  readonly expiry: NodeDelegationExpiryPolicy
  readonly sourceNodeId: Seat.SeatNodeId
  readonly methods: readonly NodePreparedRequest['method'][]
  readonly authorityExpiresAt: Seat.SeatTimestamp
  /** Persist or sign exact evidence before making its reference available to the peer.
   * @param evidence - Original grant and exact single-hop request.
   * @returns Completion after the evidence can be verified by the receiving policy.
   */
  retain(evidence: DelegationEvidence): Promise<void>
}
/** Receiver evidence lookup must use authenticated host storage or signature verification. */
export interface DelegationReceivingOptions {
  readonly permissions: readonly NodeReceivingPermissions[]
  readonly expiry: NodeDelegationExpiryPolicy
  /** Resolve independently retained evidence, not fields supplied by the wire caller.
   * @param reference - Audit reference to independently verified evidence.
   * @returns Exact retained evidence or null when unavailable or revoked.
   */
  evidence(reference: Seat.AuthorizationRef): Promise<DelegationEvidence | null>
  /** Capture locally narrowed attribution in the authorization owner.
   * @param evidence - Verified original authorization and request.
   * @param permission - Current local method ceiling and policy revision.
   * @returns Exact-operation node-delegation issuer or refusal.
   */
  issuer(evidence: DelegationEvidence, permission: NodeReceivingPermissions): Promise<Seat.SeatAuthorizationIssuer | NodeLinkFailure>
}
function refusal(request: NodeDelegationRequest): NodeLinkFailure {
  return { code: 'node-delegation-rejected', reason: 'Delegation evidence rejected', retryable: false,
    effectState: 'none', operationId: request.operationId, targetNodeId: request.targetNodeId }
}
function policy(expiry: NodeDelegationExpiryPolicy): void {
  if (!Number.isSafeInteger(expiry.maxLifetimeMs) || expiry.maxLifetimeMs <= 0
    || !Number.isSafeInteger(expiry.maxClockSkewMs) || expiry.maxClockSkewMs < 0) throw new Error('Delegation expiry policy rejected')
}
/** Capture the original entry issuer and bound its delegated lifetime.
 * @param options - Trusted original authority, allowed methods and evidence retention.
 * @returns An issuer that never infers authority from principal or origin strings.
 */
export function createDelegationIssuer(options: DelegationIssuanceOptions): NodeDelegationIssuer {
  policy(options.expiry)
  return { expiry: options.expiry, issue: async (request) => {
    const now = Date.now()
    const expires = Math.min(Date.parse(request.deadline), Date.parse(options.authorityExpiresAt), now + options.expiry.maxLifetimeMs)
    if (request.sourceNodeId !== options.sourceNodeId || request.targetNodeId === request.sourceNodeId
      || !options.methods.includes(request.method) || !Number.isFinite(expires) || expires <= now
      || request.payloadDigest !== digest(request.payload)) return { status: 'rejected', error: refusal(request) }
    const result = await options.issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest,
      ...((request.method === 'messages.send' || request.method === 'messages.sendSeat') && request.payload.delivery.callId ? { callId: request.payload.delivery.callId } : {}),
      ...((request.method === 'messages.send' || request.method === 'messages.sendSeat') && request.payload.delivery.rootCallId ? { rootCallId: request.payload.delivery.rootCallId } : {}) })
    if ('status' in result) return { status: 'rejected', error: refusal(request) }
    const fact = result.fact
    if (fact.decision !== 'allowed' || fact.kind === 'node-delegation' || fact.nodeId !== options.sourceNodeId
      || fact.operationId !== request.operationId || fact.requestDigest !== request.payloadDigest) {
      return { status: 'rejected', error: refusal(request) }
    }
    const delegation: Seat.SeatNodeDelegation = { authorizationRef: fact.authorizationId, principalId: fact.principalId,
      sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, taskIds: fact.taskIds,
      operationId: request.operationId, requestDigest: request.payloadDigest, expiresAt: new Date(expires).toISOString(),
      hop: 1, kind: 'node-delegation', ...(fact.seat ? { seat: fact.seat } : {}),
      ...(fact.sessionId ? { sessionId: fact.sessionId } : {}) }
    await options.retain(structuredClone({ request, delegation, original: fact }))
    return { status: 'issued', delegation }
  } }
}
/** Intersect peer identity, retained original authority and the current local allowlist.
 * @param options - Trusted evidence verification and local authorization owner.
 * @returns Policy that refuses missing evidence, expired grants and privilege amplification.
 */
export function createDelegationReceivingPolicy(options: DelegationReceivingOptions): NodeDelegationReceivingPolicy {
  policy(options.expiry)
  return { permissions: options.permissions, expiry: options.expiry, authorize: async (request, peer) => {
    const now = Date.now(), expires = Date.parse(request.delegation.expiresAt)
    const permission = options.permissions.find(item => item.sourceNodeId === peer.sourceNodeId && item.targetNodeId === peer.targetNodeId)
    if (!permission || !permission.methods.includes(request.method)
      || peer.sourceNodeId !== request.sourceNodeId || peer.targetNodeId !== request.targetNodeId
      || request.payloadDigest !== digest(request.payload) || expires <= now || Date.parse(request.deadline) <= now
      || !Number.isFinite(expires) || !Number.isFinite(Date.parse(request.deadline))
      || expires > Date.parse(request.deadline)
      || expires > now + options.expiry.maxLifetimeMs + options.expiry.maxClockSkewMs) return refusal(request)
    const evidence = await options.evidence(request.delegation.authorizationRef)
    const { delegation, requestId: _requestId, deadline: _deadline, ...identity } = request
    if (!evidence || evidence.original.decision !== 'allowed' || evidence.original.kind === 'node-delegation'
      || evidence.original.nodeId !== request.sourceNodeId || evidence.original.principalId !== delegation.principalId
      || evidence.original.authorizationId !== delegation.authorizationRef || evidence.original.operationId !== request.operationId
      || evidence.original.requestDigest !== request.payloadDigest || evidence.original.seat !== delegation.seat
      || evidence.original.sessionId !== delegation.sessionId || digest(evidence.original.taskIds) !== digest(delegation.taskIds)
      || digest(delegation) !== digest(evidence.delegation)) return refusal(request)
    const { requestId: _retainedId, deadline: _retainedDeadline, ...retained } = evidence.request
    if (digest(identity) !== digest(retained) || Date.parse(evidence.original.checkedAt) > now + options.expiry.maxClockSkewMs
      || !Number.isFinite(Date.parse(evidence.original.checkedAt))
      || expires - Date.parse(evidence.original.checkedAt) > options.expiry.maxLifetimeMs + options.expiry.maxClockSkewMs) {
      return refusal(request)
    }
    return options.issuer(evidence, permission)
  } }
}
