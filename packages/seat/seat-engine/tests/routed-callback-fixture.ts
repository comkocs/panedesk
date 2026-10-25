/** Durable callback setup has no transport-provider dependencies. */
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from '../src/engine.ts'
import { digest } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { freezeCallbackEvidence } from '../src/callback-evidence.ts'
import { definition, sourceId, projectId, seat, trigger } from './fixtures.ts'

export const principalId = 'principal-a' as T.SeatPrincipalId
export const owner = 'owner-a' as T.SeatNodeId
export async function persistCallback(engine: SeatEngine) {
  const nodeId = engine.options.nodeId, envelope = trigger(), operationId = 'operation-a' as T.SeatOperationId
  const ownerEpoch = 'epoch-a' as T.OwnerEpoch
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'provider-a' as T.OpeningProviderId,
    reference: 'reference-a' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen text',
  digest: digest('Frozen text'), revision: '1', taskIds: [], scopeEvidence: [] }
  const input: T.AcceptFrozenTriggerRequest = { envelope, expectedSeatRevision: 1,
    openingContext: { snapshot, openingMode: 'auto', scopeReservation: { reservationId: 'reservation-a' as T.NodeWorkChainScopeReservation['reservationId'],
      sourceId, sourceOwnerNodeId: owner, ownerEpoch, operationId, taskIds: [], snapshotDigest: snapshot.digest, policyRevision: 1 } },
    route: { sourceId, sourceOwnerNodeId: owner, ownerEpoch, triggerId: envelope.triggerId, originalOperationId: operationId,
      targetNodeId: nodeId, snapshotDigest: snapshot.digest, callbackPath: { kind: 'source', sourceId },
      modeCeiling: { mode: 'remind', policy: { sourceId, projectId, revision: 1 } } } }
  const entry = engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId, nodeId,
    origin: 'remote', sourceNodeId: owner, seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
  const grant = await entry.issuer.check({ operationId, requestDigest: digest(input) })
  if ('status' in grant) throw new Error('Missing admission grant')
  const accepted = await engine.acceptFrozen(input, { principalId, nodeId, origin: 'remote', authorization: grant })
  if (accepted.status !== 'accepted') throw new Error(`Admission failed: ${JSON.stringify(accepted)}`)
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback-a' as T.CallbackId,
    sourceId, triggerId: envelope.triggerId, stateVersion: 1, seat, title: 'Frozen title',
    sessionId: 'session-a' as NonNullable<T.SeatCallbackPayload['sessionId']>, nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
  const deliveries = await freezeCallbackEvidence(engine.journal.projection, [{ payload, payloadDigest: digest(payload),
    attempt: 0, phase: 'pending', nextDue: null, responseClass: null }])
  const delivery = deliveries[0]!
  await engine.journal.commit(() => [fact({ kind: 'callback/pending', data: delivery })])
  if (!delivery.nodeWorkChain) throw new Error('Missing durable route')
  return delivery.nodeWorkChain
}
export function admittedDefinition(): T.SeatDefinition {
  return { ...definition(), remoteAdmission: { allowOpen: true, sourceNodeIds: [owner], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen' as const], policyRevision: 1 } }
}
