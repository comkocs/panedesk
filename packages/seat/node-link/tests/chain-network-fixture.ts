/** Fixed business input and entry facts used only by the isolated network test nodes. */
import type * as Seat from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-host-admin'

/** Make an exact single-hop test request without sharing any retained evidence.
 * @param operationId - Original operation retained across process restarts.
 * @param expiresAt - Explicit delegation deadline.
 * @param size - Number of task identifiers for complete-frame limit cases.
 * @returns Request and its separately retained entry grant.
 */
export function networkInput(operationId: string, expiresAt: string, size = 1) {
  const taskIds = Array.from({ length: size }, (_, i) => `task-${i}`)
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds,
    operationId, targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  const payloadDigest = digest(payload)
  const request = { version: 'node-link/v1', requestId: `request-${operationId}`, sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId, deadline: expiresAt, hop: 1, method: 'source.prepareOpening', payload, payloadDigest,
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: `grant-${operationId}`,
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId, requestDigest: payloadDigest, taskIds, expiresAt } }
  const fact = { authorizationId: `grant-${operationId}`, kind: 'human', principalId: 'principal-a', origin: 'manual',
    nodeId: 'node-a', taskIds, operationId, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
    requestDigest: payloadDigest, checkedAt: new Date().toISOString() }
  return { request, fact }
}

/** Freeze a test business result using the received request rather than refetching input.
 * @param request - Authenticated source preparation request.
 * @returns Serializable prepared result for the durable test business owner.
 */
export function networkPrepared(request: Seat.PrepareSourceOpeningRequest) {
  const snapshotDigest = digest(request)
  const scopeReservation = { reservationId: `reservation-${request.operationId}`, sourceId: request.sourceId,
    sourceOwnerNodeId: request.sourceOwnerNodeId, ownerEpoch: request.ownerEpoch, operationId: request.operationId,
    taskIds: request.taskIds, snapshotDigest, policyRevision: 1 }
  return { status: 'prepared', expectedSeatRevision: request.expectedSeatRevision,
    openingContext: { snapshot: { reference: request.reference, text: 'Frozen input', digest: snapshotDigest,
      revision: '1', taskIds: request.taskIds, scopeEvidence: [] }, scopeReservation, openingMode: request.openingMode },
    route: { sourceId: request.sourceId, sourceOwnerNodeId: request.sourceOwnerNodeId, ownerEpoch: request.ownerEpoch,
      triggerId: null, originalOperationId: request.operationId, targetNodeId: request.targetNodeId, snapshotDigest,
      callbackPath: { kind: 'opening-context', reference: request.reference, operationId: request.operationId },
      modeCeiling: { mode: 'remind', policy: { sourceId: request.sourceId, projectId: 'project-a', revision: 1 } } } }
}
