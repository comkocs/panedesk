/** Sanitized automatic-opening history preserves the source, local-open and separate-close identities. */
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { authorizationFrame, decodeAuthorizationFrame, type AuthorizationDecision } from '../src/authorization-storage.ts'
import { freezeCallbackEvidence } from '../src/callback-evidence.ts'
import { digest } from '../src/journal.ts'
import { EngineProjection } from '../src/projection.ts'
import { fact } from '../src/triggers.ts'
import { auto, budget, harness, nodeId, seat, sourceId, trigger } from './fixtures.ts'

export const sourceOperation = 'source-operation' as T.SeatOperationId
export const openingOperation = 'local-opening' as T.SeatOperationId
export const closingOperation = 'local-closing' as T.SeatOperationId
export const sessionId = 'session-a' as SessionId

export async function acceptAutomatic(h: Awaited<ReturnType<typeof harness>>) {
  await auto(h.engine)
  const envelope = { ...trigger(), taskId: 'task-a' as T.SeatTaskId }
  const owner = 'source-owner' as T.SeatNodeId, principalId = 'source-principal' as T.SeatPrincipalId
  const ownerEpoch = 'source-epoch' as T.OwnerEpoch
  const snapshot: T.OpeningContextSnapshot = { reference: { providerId: 'provider-a' as T.OpeningProviderId,
    reference: 'reference-a' as T.OpeningContextReference['reference'], revision: '1' }, text: 'Frozen opening',
  digest: digest('Frozen opening'), revision: '1', taskIds: [envelope.taskId], scopeEvidence: [] }
  const input: T.AcceptFrozenTriggerRequest = { envelope, expectedSeatRevision: 1,
    openingContext: { snapshot, openingMode: 'auto', scopeReservation: {
      reservationId: 'reservation-a' as T.NodeWorkChainScopeReservation['reservationId'], sourceId, sourceOwnerNodeId: owner,
      ownerEpoch, operationId: sourceOperation, taskIds: snapshot.taskIds, snapshotDigest: snapshot.digest, policyRevision: 1 } },
    route: { sourceId, sourceOwnerNodeId: owner, ownerEpoch, triggerId: envelope.triggerId,
      originalOperationId: sourceOperation, targetNodeId: nodeId, snapshotDigest: snapshot.digest,
      callbackPath: { kind: 'source', sourceId }, modeCeiling: { mode: 'auto', policy: {
        sourceId, projectId: envelope.projectId, revision: 1 } } } }
  h.definitions.get(seat)!.remoteAdmission = { allowOpen: true, sourceNodeIds: [owner], sourceIds: [sourceId],
    principalIds: [principalId], methods: ['engine.acceptFrozen'], policyRevision: 1 }
  h.engine.registerPreopenRetention({ sourceId, sourceOwnerNodeId: owner, limitMs: 900000 })
  h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Frozen opening', openingMode: 'auto' }), recheck: async () => null })
  const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId, nodeId,
    origin: 'remote', sourceNodeId: owner, seat, taskIds: snapshot.taskIds, policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
  const grant = await entry.issuer.check({ operationId: sourceOperation, requestDigest: digest(input) })
  if ('status' in grant) throw new Error('Expected admission grant')
  const accepted = await h.engine.acceptFrozen(input, { principalId, nodeId, origin: 'remote', authorization: grant })
  if (accepted.status !== 'accepted') throw new Error('Expected automatic acceptance')
  return input
}

export function replayOperation(frames: readonly AuthorizationDecision[], count = frames.length) {
  const view = new EngineProjection()
  for (const frame of frames.slice(0, count)) view.applyAuthorization(decodeAuthorizationFrame(JSON.stringify(frame), 200000))
  return view
}

export async function operationHistory() {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  try {
    await acceptAutomatic(h)
    const admission = h.engine.journal.projection.authorizationDecisions.at(-1)!
    const accepted = admission.effects.find(effect => effect.kind === 'trigger/accepted')!
    if (accepted.kind !== 'trigger/accepted') throw new Error('Expected original trigger')
    const pending = accepted.data.pending, source = accepted.data.trigger
    const binding: T.SeatBinding = { kind: 'seat', sessionId, seat, nodeId, projectId: pending.projectId,
      bindingSource: 'seat-definition', identitySource: 'settings', openOperationId: openingOperation, seatRevision: 1,
      ...(source.taskId ? { taskId: source.taskId } : {}), relatedTaskIds: pending.relatedTaskIds, directories: [], memoryDirectories: [],
      subscriptions: [], openingDigest: digest('Frozen opening') }
    const open: T.EngineOpenData = { intentId: 'intent-a' as T.OpenIntentId, sessionId, seatRevision: 1, phase: 'intent',
      completedStages: [], binding, openingOperationId: openingOperation, openingMessageId: null,
      openingDigest: binding.openingDigest, budget: budget(sessionId), failure: null, sources: pending.sources,
      title: 'Frozen opening', definition: h.definitions.get(seat)! }
    const frames: AuthorizationDecision[] = []
    const append = (effects: AuthorizationDecision['effects']) => {
      const sequence = frames.length + 1
      frames.push(authorizationFrame({ schemaVersion: 1, namespace: 'ledger/engine/v1', nodeId, sequence,
        decisionId: `decision-${sequence}` as T.EngineDecisionId, observedAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
        policyRevision: 1, ...(frames.length === 0 ? { requiredCapabilities: ['node-work-chain/v1'] as const } : {}), effects }))
    }
    append(admission.effects)
    const owner = { sessionId, intentId: open.intentId, ownerEpoch: 'window-epoch' as T.OwnerEpoch, resourceRevision: 1 }
    append([fact({ kind: 'queue/cancelled', data: { pending, previousRevision: pending.stateVersion,
      revision: pending.stateVersion + 1, principalId: 'engine-policy' as T.SeatPrincipalId } }),
    fact({ kind: 'open/intent', triggerId: source.triggerId, sessionId, seat, data: open }),
    fact({ kind: 'resource/reserved', sessionId, seat, data: { owner, nodeId, seat,
      exclusiveTags: [], engineWindowUnits: 1, seatWindowUnits: 1 } })])
    const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'opened-callback' as T.CallbackId,
      sourceId, triggerId: source.triggerId, sessionId, seat, nodeId, nodeName: 'node-a', stateVersion: 3,
      title: 'Frozen opening', budget: {}, ...(source.taskId ? { taskId: source.taskId } : {}), relatedTaskIds: pending.relatedTaskIds }
    const [opened] = await freezeCallbackEvidence(replayOperation(frames), [{ payload, payloadDigest: digest(payload),
      phase: 'pending', attempt: 0, nextDue: null, responseClass: null }])
    if (!opened) throw new Error('Expected opened callback')
    append([fact({ kind: 'open/created', sessionId, seat, data: { ...open, phase: 'created' } }),
      fact({ kind: 'callback/pending', sessionId, data: opened })])
    for (let i = 0; i < 8; i++) append([fact({ kind: 'open/configured', sessionId, seat,
      data: { ...open, phase: i < 6 ? 'configuring' : 'opening-pending' } })])
    append([fact({ kind: 'callback/attempted', operationId: sourceOperation, data: { ...opened, responseClass: 'unknown' } })])
    append([fact({ kind: 'open/configured', sessionId, seat, data: { ...open, phase: 'active' } })])
    append([fact({ kind: 'callback/attempted', sessionId, data: { ...opened, attempt: 1,
      phase: 'retry-due', responseClass: 'transient', nextDue: '2026-01-01T00:00:21.000Z' } })])
    append([fact({ kind: 'callback/delivered', sessionId, data: { ...opened, attempt: 2, phase: 'delivered', responseClass: 'success' } })])
    const closed: T.EngineCloseData = { operationId: closingOperation, sessionId, phase: 'closed', reason: 'manual',
      stateVersion: 27, endedAt: '2026-01-01T00:00:17.000Z', reportId: null, selfReport: null, selfReportStatus: 'not-submitted' }
    append([fact({ kind: 'window/closing', operationId: closingOperation, sessionId,
      data: { ...closed, phase: 'admission', stateVersion: 26, endedAt: null } })])
    const endedPayload: T.SeatCallbackPayload = { ...payload, kind: 'window-ended', callbackId: 'ended-callback' as T.CallbackId,
      stateVersion: 17, endedAt: closed.endedAt!, reason: 'manual', selfReport: null, selfReportStatus: 'not-submitted' }
    const [ended] = await freezeCallbackEvidence(replayOperation(frames), [{ payload: endedPayload,
      payloadDigest: digest(endedPayload), phase: 'pending', attempt: 0, nextDue: null, responseClass: null }])
    if (!ended) throw new Error('Expected ended callback')
    append([fact({ kind: 'window/closed', sessionId, data: closed }), fact({ kind: 'resource/released', sessionId,
      data: { owner, observedAt: closed.endedAt!, releasedAt: closed.endedAt!, engineReadyAt: null, fenced: true, reason: 'window-closed' } }),
    fact({ kind: 'callback/pending', sessionId, data: ended })])
    append([fact({ kind: 'callback/attempted', operationId: sourceOperation, data: { ...ended, responseClass: 'unknown' } })])
    append([fact({ kind: 'callback/attempted', sessionId, data: { ...ended, attempt: 1,
      phase: 'retry-due', responseClass: 'transient', nextDue: '2026-01-01T00:00:21.000Z' } })])
    append([fact({ kind: 'callback/delivered', sessionId, data: { ...ended, attempt: 2, phase: 'delivered', responseClass: 'success' } })])
    return { frames, pending, open }
  } finally { await h.close() }
}
