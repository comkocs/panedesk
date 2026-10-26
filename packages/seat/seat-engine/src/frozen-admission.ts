/** Frozen ingress binds a complete business key to one journal admission and its original result. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import { digest, EngineError } from './journal.ts'
import { authorizationEffect, type AuthorizationIssuers } from './authorization-issuer.ts'
import type { ChainAcceptedEffect } from './chain-storage.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { effectiveMode } from './admission.ts'
import { fact, rejected, reminderEffects } from './triggers.ts'

/** Recover the exact first acknowledgement, not the current mutable queue state.
 * @param view - Recovered committed journal.
 * @param request - Complete business identity and original payload digest.
 * @returns Original result, conflict, or absence after recovery.
 */
export function queryFrozen(view: EngineProjection, request: T.NodeWorkChainOperationRequest): T.NodeWorkChainOperationResult {
  for (const frame of view.authorizationDecisions) {
    const route = frame.effects.find(effect => effect.kind === 'node-route/accepted'
      && digest(effect.data.operationKey) === digest(request.key))
    if (route?.kind !== 'node-route/accepted') continue
    if (route.data.payloadDigest !== request.payloadDigest) return rejected('operation-id-conflict', 'Frozen operation payload conflicts')
    const intent = frame.effects.find(effect => (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced')
      && effect.operationId === request.key.operationId && effect.seat === route.seat)
    if (!intent || (intent.kind !== 'trigger/accepted' && intent.kind !== 'trigger/coalesced')) {
      throw new EngineError('engine-store-corrupt', 'Frozen admission has no original intent')
    }
    const pending = intent.data.pending
    if (request.key.method === 'engine.acceptFrozen') return { status: 'settled', method: 'engine.acceptFrozen', result: {
      status: intent.kind === 'trigger/accepted' ? 'accepted' : 'coalesced', triggerId: intent.data.trigger.triggerId,
      queueItemId: pending.queueItemId, sequence: pending.sequence } }
    const result: T.SeatQueued = { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
      reason: pending.reason, blockedBy: pending.blockedBy }
    if (request.key.method === 'seat.openFrozen') return { status: 'settled', method: 'seat.openFrozen', result }
    if (request.key.method === 'seat.wakeFrozen') return { status: 'settled', method: 'seat.wakeFrozen', result: { status: 'opened', result } }
  }
  return { status: 'missing' }
}

/** Capture identity only from the authenticated local delegation fact.
 * @param request - Frozen wire payload.
 * @param authority - Process-local caller with an issuer-owned grant.
 * @param method - Invoked frozen method.
 * @returns Complete retained input, or a refusal before any write.
 */
export function frozenIdentity(request: T.AcceptFrozenTriggerRequest | T.OpenFrozenSeatRequest | T.WakeFrozenSeatRequest,
  authority: T.SeatCallContext, method: T.SeatRemoteOpeningMethod): T.NodeWorkChainAcceptedData | T.SeatRejected {
  const grant = authority.authorization, data = grant?.fact
  if (!data || data.kind !== 'node-delegation' || !data.sourceNodeId || data.principalId !== authority.principalId
    || data.nodeId !== authority.nodeId || data.requestDigest !== digest(request)) {
    return rejected('unauthorized', 'Frozen admission requires authenticated sending-node attribution')
  }
  const input: T.NodeWorkChainAcceptedData = { capability: 'node-work-chain/v1', route: structuredClone(request.route),
    openingContext: structuredClone(request.openingContext), expectedSeatRevision: request.expectedSeatRevision,
    authorizationRef: data.authorizationId, payloadDigest: data.requestDigest,
    operationKey: { sourceNodeId: data.sourceNodeId, principalId: data.principalId, sourceId: request.route.sourceId,
      ownerEpoch: request.route.ownerEpoch, method, operationId: data.operationId },
    trigger: 'envelope' in request ? structuredClone(request.envelope) : null }
  if (request.route.originalOperationId !== data.operationId || request.route.targetNodeId !== authority.nodeId
    || 'request' in request && (request.request.operationId !== data.operationId
      || request.request.nodeId !== undefined && request.request.nodeId !== authority.nodeId)) {
    return rejected('invalid-request', 'Frozen input does not match its original business identity')
  }
  return input
}

/** Compare retained admission with current target policy without renewing its original authority.
 * @param input - Previously frozen business identity and expected definition revision.
 * @param definition - Current execution-node seat definition.
 * @returns Confirmed no-effect refusal, or permission to continue the independent execution recheck.
 */
export function recheckFrozenDefinition(input: T.NodeWorkChainAcceptedData, definition: T.SeatDefinition): T.SeatRejected | null {
  const policy = definition.remoteAdmission
  if (!policy?.allowOpen || !policy.sourceNodeIds.includes(input.operationKey.sourceNodeId)
    || !policy.sourceIds.includes(input.route.sourceId) || !policy.principalIds.includes(input.operationKey.principalId)
    || !policy.methods.includes(input.operationKey.method as T.SeatRemoteOpeningMethod)) {
    return rejected('unauthorized', 'Remote opening is not allowed for this source, principal and method')
  }
  if (definition.revision !== input.expectedSeatRevision) return rejected('revision-conflict', 'Frozen seat revision changed')
  return null
}

/** Recheck target policy and live issuer ownership inside the journal transaction.
 * @param issuers - Journal owner's live grant registry.
 * @param grant - Original process-local authorization.
 * @param input - Complete frozen admission.
 * @param definition - Target-local definition, never source configuration.
 * @param nodeId - Executing journal node.
 * @returns Verified authorization effect for a previously unaccepted operation.
 */
export function authorizeFrozen(issuers: AuthorizationIssuers, grant: T.SeatAuthorizationGrant,
  input: T.NodeWorkChainAcceptedData, definition: T.SeatDefinition, nodeId: T.SeatNodeId): ReturnType<typeof authorizationEffect> {
  const data = issuers.verify(grant, { operationId: input.operationKey.operationId, requestDigest: input.payloadDigest,
    ...(grant.fact.callId ? { callId: grant.fact.callId } : {}),
    ...(grant.fact.rootCallId ? { rootCallId: grant.fact.rootCallId } : {}) }, nodeId)
  if (data.decision !== 'allowed' || data.kind !== 'node-delegation' || data.sourceNodeId !== input.operationKey.sourceNodeId
    || data.principalId !== input.operationKey.principalId || data.seat !== definition.seat
    || input.openingContext.snapshot.taskIds.some(task => !data.taskIds.includes(task))) {
    throw new EngineError('unauthorized', 'Frozen operation requires matching live authority')
  }
  const refusal = recheckFrozenDefinition(input, definition)
  if (refusal) throw new EngineError(refusal.error.code, refusal.error.message)
  if (input.openingContext.staffBinding && input.openingContext.staffBinding.seat !== definition.seat) {
    throw new EngineError('unauthorized', 'Frozen staff binding targets another seat')
  }
  return authorizationEffect(data)
}

/** Build an indivisible accepted trigger and route without consulting a source provider.
 * @param view - Latest journal state inside its serialized writer.
 * @param input - Verified frozen admission.
 * @param envelope - Retained original or locally derived trigger.
 * @param frozen - Target-local frozen configuration and original source text.
 * @param ruleMode - Current local trigger restriction.
 * @returns Complete intent and route effects, or a policy refusal.
 */
export function frozenEffects(view: EngineProjection, input: T.NodeWorkChainAcceptedData, envelope: T.TriggerEnvelope,
  frozen: T.SeatFrozenOpen, ruleMode?: T.EngineMode): AuthorizationDecision['effects'] | T.SeatRejected {
  const mode = effectiveMode(effectiveMode(view.policies.get(envelope.projectId)?.mode ?? 'remind', ruleMode),
    input.route.modeCeiling.mode)
  if (mode === 'off') return rejected('disabled', 'Automatic triggering is disabled')
  const pending: T.PendingSeatItem = { queueItemId: randomUUID() as T.QueueItemId, seat: envelope.seat,
    projectId: envelope.projectId, triggerKind: envelope.kind, action: 'open', sequence: view.sequence + 1,
    effectiveMode: mode, reason: mode === 'remind' ? 'approval' : 'provider-unavailable', blockedBy: [], sources: [envelope],
    relatedTaskIds: [...input.openingContext.snapshot.taskIds], queuedAt: new Date().toISOString(), stateVersion: 1,
    frozenOpen: frozen }
  const operationId = input.operationKey.operationId
  const route: ChainAcceptedEffect = { kind: 'node-route/accepted', eventId: randomUUID() as T.EngineEventId,
    operationId, seat: envelope.seat, data: input }
  return [fact({ kind: 'trigger/accepted', seat: envelope.seat, triggerId: envelope.triggerId, operationId, data: {
    trigger: envelope, pending, originalTriggerId: null, deduplication: { key: digest(input.operationKey),
      digest: input.payloadDigest, receivedAt: envelope.receivedAt, bucket: null, sourceId: envelope.sourceId,
      eventId: envelope.eventId ?? null } } }), route, ...reminderEffects(pending, undefined)]
}
