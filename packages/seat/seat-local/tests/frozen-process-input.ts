/** Stable wire inputs are shared by the independent writer and recovery processes. */
import type * as T from '@panedesk/dsh-seat'
import { digest } from '@panedesk/dsh-seat-engine'
import { methods, principalId } from './frozen-process-fixture.ts'

/** Build one complete frozen request and its exact retained query.
 * @param method - Target provider method.
 * @param definition - Persisted receiving seat.
 * @returns Original payload and complete business key.
 */
export function processInput(method: typeof methods[number], definition: T.SeatDefinition) {
  const operationId = `process:${method}` as T.SeatOperationId, sourceId = 'remote-source' as T.SeatSourceId
  const ownerEpoch = 'owner-epoch' as T.OwnerEpoch, owner = 'owner-node' as T.SeatNodeId
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'absent-provider' as T.OpeningProviderId,
    reference: 'reference' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen source text',
  digest: digest('Frozen source text'), revision: '1', taskIds: [], scopeEvidence: [] }
  const openingContext: T.OpenFrozenSeatRequest['openingContext'] = { snapshot, openingMode: 'prefill', scopeReservation: {
    reservationId: 'reservation' as T.NodeWorkChainScopeReservation['reservationId'], sourceId, sourceOwnerNodeId: owner,
    ownerEpoch, operationId, taskIds: [], snapshotDigest: snapshot.digest, policyRevision: 1 } }
  const envelope: T.TriggerEnvelope = { triggerId: 'process-trigger' as T.TriggerId, sourceId, kind: 'manual',
    evidence: { kind: 'manual', origin: 'remote', operationId }, seat: definition.seat, projectId: definition.projectId,
    receivedAt: '2026-01-01T00:00:00.000Z', data: null, dataDigest: digest(null), callbackRef: sourceId, relatedTaskIds: [] }
  const route: T.NodeWorkChainRoute = { sourceId, sourceOwnerNodeId: owner, ownerEpoch,
    triggerId: method === 'engine.acceptFrozen' ? envelope.triggerId : null,
    originalOperationId: operationId, targetNodeId: 'node-a' as T.SeatNodeId, snapshotDigest: snapshot.digest,
    callbackPath: { kind: 'opening-context', reference: snapshot.reference, operationId },
    modeCeiling: { mode: 'remind', policy: { sourceId, projectId: definition.projectId, revision: 1 } } }
  const base = { openingContext, route, expectedSeatRevision: definition.revision }
  const payload = method === 'engine.acceptFrozen' ? { ...base, envelope }
    : method === 'seat.openFrozen' ? { ...base, request: { seat: definition.seat, operationId, origin: 'remote' as const } }
      : { ...base, request: { seat: definition.seat, operationId } }
  const query: T.NodeWorkChainOperationRequest = { key: {
    sourceNodeId: route.sourceOwnerNodeId, principalId, sourceId, ownerEpoch, method, operationId }, payloadDigest: digest(payload) }
  return { method, payload, query, operationId }
}
