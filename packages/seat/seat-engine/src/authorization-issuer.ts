/** Instance-owned grants bind host-captured attribution to one exact action. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import { EngineError } from './journal.ts'
import { validAuthorization, type AuthorizationEffect } from './authorization-storage.ts'
import { rejected } from './triggers.ts'

/** Only a registered host closure can mint a grant accepted by this journal owner. */
export class AuthorizationIssuers implements T.SeatAuthorizationIssuers {
  private readonly grants = new WeakMap<T.SeatAuthorizationGrant, () => boolean>()
  private active = true

  register(entry: T.SeatAuthorizationEntry): ReturnType<T.SeatAuthorizationIssuers['register']> {
    const identity = structuredClone(entry.identity)
    let active = true
    const check = (request: T.SeatAuthorizationCheck): T.SeatAuthorizationGrant | T.SeatRejected => {
      if (Object.keys(request).some(key => !['operationId', 'requestDigest', 'callId', 'rootCallId'].includes(key))) {
        return rejected('unauthorized', 'Caller-defined authorization attribution is not accepted')
      }
      const policy = entry.current()
      if (!active || !this.active || !policy || request.callId !== identity.callId || request.rootCallId !== identity.rootCallId) {
        return rejected('unauthorized', 'The captured authorization entry is no longer valid')
      }
      const fact: T.SeatIssuedAuthorizationFact = { ...identity, ...request, ...policy,
        authorizationId: randomUUID() as T.AuthorizationRef, checkedAt: new Date().toISOString() }
      if (!validAuthorization(fact)) return rejected('invalid-request', 'Authorization evidence is incomplete')
      Object.freeze(fact.taskIds)
      // The private interface brand is implemented by this owner's identity registry, not JSON fields.
      const grant = Object.freeze({ fact: Object.freeze(fact) }) as T.SeatAuthorizationGrant
      this.grants.set(grant, () => {
        const current = entry.current()
        return active && this.active && current !== null && current.policyRevision === fact.policyRevision
          && current.decision === fact.decision && current.reasonCode === fact.reasonCode
      })
      return grant
    }
    const issuer: T.SeatAuthorizationIssuer = { check: request => Promise.resolve(check(request)) }
    return { issuer: Object.freeze(issuer), dispose: () => { active = false } }
  }

  /** Check ownership and live policy while holding the journal serialization slot.
   * @param grant - Process-local issuer result.
   * @param request - Exact operation, digest and invocation identity.
   * @param nodeId - Journal owner identity.
   * @returns Detached immutable durable attribution.
   */
  verify(grant: T.SeatAuthorizationGrant, request: T.SeatAuthorizationCheck, nodeId: T.SeatNodeId): T.SeatIssuedAuthorizationFact {
    const current = this.grants.get(grant)
    if (!current || !current()) throw new EngineError('unauthorized', 'Authorization grant is foreign, revoked or stale')
    const data = grant.fact
    if (data.nodeId !== nodeId || data.operationId !== request.operationId || data.requestDigest !== request.requestDigest
      || data.callId !== request.callId || data.rootCallId !== request.rootCallId) {
      throw new EngineError('unauthorized', 'Authorization grant does not match this action')
    }
    return { ...data, taskIds: [...data.taskIds] }
  }

  /** Revoke all outstanding grants when their provider is disposed. */
  close(): void { this.active = false }
}

/** Produce one required-capability effect without caller-defined event metadata.
 * @param data - Verified issued attribution.
 * @returns Durable authorization fact sharing its action's journal frame.
 */
export function authorizationEffect(data: T.SeatIssuedAuthorizationFact): AuthorizationEffect {
  return { kind: 'authorization/checked', capability: 'seat-authorization/v1',
    eventId: data.authorizationId as string as T.EngineEventId, operationId: data.operationId,
    ...(data.seat ? { seat: data.seat } : {}), ...(data.sessionId ? { sessionId: data.sessionId } : {}), data }
}
