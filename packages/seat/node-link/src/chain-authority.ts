/** Independently fetched evidence is checked before local policy can issue a narrowed grant. */
import { digest } from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import type { ChainRequest, ChainFailure } from './chain-types.ts'
import type { ChainReceivingPolicy } from './chain-services.ts'
import type { NodeAuthenticatedPeer } from './delegation.ts'
import { chainFailure } from './chain-identity.ts'

type EvidenceLookup = (request: Seat.NodeDelegationEvidenceRequest) => Promise<Seat.NodeDelegationEvidenceResult>

/** Verify peer, independent evidence and the exact locally issued process grant.
 * @param request - Fully decoded request, never a self-declared original fact.
 * @param peer - Transport-derived authenticated node pair.
 * @param policy - Explicit stable-account and local-admission policy; absence rejects.
 * @param lookup - Same-channel exact retained evidence lookup.
 * @returns Local call context or a structured refusal.
 */
export async function chainAuthority(request: ChainRequest, peer: NodeAuthenticatedPeer,
  policy: ChainReceivingPolicy | undefined, lookup: EvidenceLookup): Promise<Seat.SeatCallContext | ChainFailure> {
  const refuse = (reason: Seat.NodeWorkChainReasonCode): ChainFailure => {
    const response = chainFailure(request, 'node-delegation-rejected', reason)
    if (response.status === 'ok') throw new Error('Node chain refusal unavailable')
    return response.error
  }
  if (request.sourceNodeId !== peer.sourceNodeId || request.targetNodeId !== peer.targetNodeId) return refuse('node-mismatch')
  if (!policy) return refuse('hello-policy-not-ready')
  const now = Date.now(), delegation = request.delegation, expires = Date.parse(delegation.expiresAt)
  if (expires <= now || Date.parse(request.deadline) <= now || expires > Date.parse(request.deadline)
    || expires > now + policy.expiry.maxLifetimeMs + policy.expiry.maxClockSkewMs) return refuse('deadline-exceeded')
  const wanted: Seat.NodeDelegationEvidenceRequest = { authorizationRef: delegation.authorizationRef,
    method: request.method, operationId: request.operationId, payloadDigest: request.payloadDigest,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId }
  const evidence = await lookup(wanted)
  if (evidence.status !== 'retained') return refuse(evidence.cause.reasonCode ?? 'evidence-missing')
  if (digest(evidence.request) !== digest(wanted)) return refuse('evidence-digest-mismatch')
  const fact = evidence.fact, checked = Date.parse(fact.checkedAt)
  if (fact.decision !== 'allowed' || fact.kind === 'node-delegation' || fact.nodeId !== peer.sourceNodeId
    || fact.authorizationId !== delegation.authorizationRef || fact.operationId !== request.operationId
    || fact.requestDigest !== request.payloadDigest || fact.principalId !== delegation.principalId
    || fact.seat !== delegation.seat || fact.sessionId !== delegation.sessionId
    || digest(fact.taskIds) !== digest(delegation.taskIds) || !Number.isFinite(checked)
    || checked > now + policy.expiry.maxClockSkewMs || Date.parse(evidence.expiresAt) < expires
    || !Number.isFinite(Date.parse(evidence.expiresAt)) || expires - checked > policy.expiry.maxLifetimeMs + policy.expiry.maxClockSkewMs) {
    return refuse('evidence-digest-mismatch')
  }
  const issuer = await policy.authorize(request, peer, evidence)
  if ('code' in issuer) return issuer
  const grant = await issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest })
  if ('status' in grant) return refuse('method-not-allowed')
  const local = grant.fact
  if (local.kind !== 'node-delegation' || local.decision !== 'allowed' || local.nodeId !== peer.targetNodeId
    || local.sourceNodeId !== peer.sourceNodeId
    || local.principalId !== delegation.principalId || local.delegatedBy !== delegation.authorizationRef
    || local.operationId !== request.operationId || local.requestDigest !== request.payloadDigest
    || local.seat !== delegation.seat || local.sessionId !== delegation.sessionId
    || local.taskIds.some(task => !delegation.taskIds.includes(task))) return refuse('method-not-allowed')
  return { principalId: local.principalId, origin: local.origin, nodeId: peer.targetNodeId, authorization: grant }
}
