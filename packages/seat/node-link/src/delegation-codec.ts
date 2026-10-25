/** Shared single-hop delegation validation grants no authority from wire strings. */
import { identifier, object } from '@panedesk/dsh-host-admin'

/** Check delegation fields against the already validated request identity.
 * @param value - Parsed request with validated envelope and payload.
 * @returns Whether the complete delegation matches the request.
 */
export function validDelegation(value: Record<string, unknown>): boolean {
  const delegation = value.delegation
  return object(delegation) && delegation.kind === 'node-delegation' && delegation.hop === 1
    && identifier(delegation.principalId) && identifier(delegation.authorizationRef)
    && delegation.sourceNodeId === value.sourceNodeId && delegation.targetNodeId === value.targetNodeId
    && delegation.operationId === value.operationId && delegation.requestDigest === value.payloadDigest
    && typeof delegation.expiresAt === 'string' && Number.isFinite(Date.parse(delegation.expiresAt))
    && Array.isArray(delegation.taskIds) && delegation.taskIds.every(identifier)
    && (delegation.seat === undefined || identifier(delegation.seat))
    && (delegation.sessionId === undefined || identifier(delegation.sessionId))
    && Object.keys(delegation).every(key => ['kind', 'hop', 'principalId', 'authorizationRef', 'sourceNodeId', 'targetNodeId',
      'operationId', 'requestDigest', 'expiresAt', 'taskIds', 'seat', 'sessionId'].includes(key))
}
