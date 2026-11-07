/** Node batches bind each derived opening to the original batch authorization in one frame. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { digest, EngineError } from './journal.ts'
import { fact, rejected } from './triggers.ts'

/** Private writer evidence; legacy readers refuse the new effect discriminator. */
export interface NodeBatchEffect extends T.EngineEffectBase {
  kind: 'node-batch/accepted'
  data: {
    request: T.OpenSeatBatchRequest
    sourceNodeId: T.SeatNodeId
    principalId: T.SeatPrincipalId
    seat: T.SeatName
    authorizationRef?: T.AuthorizationRef
    actionDigest: T.SeatDigest
  }
}

/** Derive a collision-free member identity without changing the original wire grant.
 * @param request - Original explicit batch.
 * @param sourceNodeId - Authenticated sending node.
 * @param principalId - Captured receiving principal.
 * @param seat - One explicitly requested member.
 * @returns Stable local operation identity across retries and restarts.
 */
export function batchMemberId(request: T.OpenSeatBatchRequest, sourceNodeId: T.SeatNodeId,
  principalId: T.SeatPrincipalId, seat: T.SeatName): T.SeatOperationId {
  return digest(['seat.openBatch', sourceNodeId, principalId, request.operationId, seat]) as string as T.SeatOperationId
}

/** Recover only the first committed member acknowledgement.
 * @param view - Recovered journal state.
 * @param request - Original batch payload.
 * @param sourceNodeId - Authenticated sending node.
 * @param principalId - Captured receiving principal.
 * @param seat - Selected member.
 * @returns Original result, payload conflict, or no committed member.
 */
export function queryBatchMember(view: EngineProjection, request: T.OpenSeatBatchRequest,
  sourceNodeId: T.SeatNodeId, principalId: T.SeatPrincipalId, seat: T.SeatName): T.OpenSeatResult | undefined {
  for (const frame of view.authorizationDecisions) {
    const binding = frame.effects.find(effect => effect.kind === 'node-batch/accepted'
      && effect.data.sourceNodeId === sourceNodeId && effect.data.principalId === principalId
      && effect.data.request.operationId === request.operationId)
    if (binding?.kind !== 'node-batch/accepted') continue
    if (digest(binding.data.request) !== digest(request)) return rejected('operation-id-conflict', 'Batch payload conflicts with committed members')
    if (binding.data.seat !== seat) continue
    const intent = frame.effects.find(effect => effect.kind === 'trigger/accepted' && effect.operationId === binding.operationId)
    if (intent?.kind !== 'trigger/accepted') throw new EngineError('engine-store-corrupt', 'Batch member intent is missing')
    const pending = intent.data.pending
    return { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
      reason: pending.reason, blockedBy: [...pending.blockedBy] }
  }
  return undefined
}

/** Build one queued member; external creation remains owned by the ordinary engine driver.
 * @param view - Latest serialized projection.
 * @param input - Locally frozen member input.
 * @param request - Original authorized batch.
 * @param sourceNodeId - Authenticated sending node.
 * @param principalId - Captured receiving principal.
 * @param recheckRequired - Whether queued dispatch requires the registered execution policy.
 * @returns Bound action and original acknowledgement in a single decision.
 */
export function batchMemberEffects(view: EngineProjection, input: T.SeatLocalOpenRequest,
  request: T.OpenSeatBatchRequest, sourceNodeId: T.SeatNodeId,
  principalId: T.SeatPrincipalId, recheckRequired: boolean): AuthorizationDecision['effects'] {
  const operationId = input.request.operationId, sourceId = 'seat-local-manual' as T.SeatSourceId
  const triggerId = operationId as string as T.TriggerId, now = new Date().toISOString()
  const data = JSON.parse(JSON.stringify({ request: input.request, definition: input.definition,
    opening: input.opening, title: input.title })) as T.SeatJson
  const trigger: T.TriggerEnvelope = { triggerId, sourceId, eventId: triggerId as string as T.SourceEventId,
    kind: 'manual', evidence: { kind: 'manual', origin: request.origin, operationId }, seat: input.request.seat,
    projectId: input.definition.projectId, receivedAt: now, data, dataDigest: digest(data), callbackRef: sourceId }
  const pending: T.PendingSeatItem = { queueItemId: randomUUID() as T.QueueItemId, seat: input.request.seat,
    projectId: input.definition.projectId, triggerKind: 'manual', action: 'open', sequence: view.sequence + 1,
    effectiveMode: 'auto', reason: 'provider-unavailable', blockedBy: [], sources: [trigger], relatedTaskIds: [],
    queuedAt: now, stateVersion: 1, frozenOpen: { ...(recheckRequired ? { recheckRequired: true } : {}),
      definition: structuredClone(input.definition), title: input.title,
      frozenOpening: structuredClone(input.opening), openingMode: request.origin === 'manual' ? request.openingMode ?? 'auto' : 'auto' } }
  return [fact({ kind: 'trigger/accepted', operationId, seat: input.request.seat, triggerId, data: {
    trigger, pending, originalTriggerId: null, deduplication: { key: digest(['node-batch', operationId]),
      digest: digest(data), receivedAt: now, bucket: null, sourceId, eventId: trigger.eventId ?? null } } }),
  { kind: 'node-batch/accepted', eventId: randomUUID() as T.EngineEventId, operationId, seat: input.request.seat,
    data: { request: structuredClone(request), sourceNodeId, principalId,
      seat: input.request.seat, actionDigest: digest(input.request) } }]
}

/** Validate original wire attribution and the unique derived action during write and replay.
 * @param decision - Checksum-verified expanded decision.
 */
export function validateBatchFrame(decision: AuthorizationDecision): void {
  for (const binding of decision.effects) {
    if (binding.kind !== 'node-batch/accepted') continue
    const data = (binding as Partial<NodeBatchEffect>).data
    const request = data?.request
    if (!data || !request || !Array.isArray(request.seats) || !request.seats.length
      || request.seats.some(seat => typeof seat !== 'string' || !seat.trim() || /[*?]/.test(seat))
      || new Set(request.seats).size !== request.seats.length || !request.seats.includes(data.seat)
      || typeof request.operationId !== 'string' || !request.operationId || !['manual', 'remote'].includes(request.origin)
      || request.openingMode !== undefined && !['auto', 'prefill'].includes(request.openingMode)
      || request.nodeId !== undefined && request.nodeId !== decision.nodeId
      || typeof data.sourceNodeId !== 'string' || !data.sourceNodeId || typeof data.principalId !== 'string' || !data.principalId
      || binding.seat !== data.seat || binding.operationId !== batchMemberId(request, data.sourceNodeId, data.principalId, data.seat)) {
      throw new EngineError('engine-store-corrupt', 'Invalid batch member identity')
    }
    const authorization = data.authorizationRef === undefined ? undefined
      : decision.effects.find(effect => effect.kind === 'authorization/checked'
        && effect.data.authorizationId === data.authorizationRef)
    const intent = decision.effects.find(effect => effect.kind === 'trigger/accepted' && effect.operationId === binding.operationId)
    const action: T.OpenSeatRequest = { seat: data.seat,
      operationId: batchMemberId(request, data.sourceNodeId, data.principalId, data.seat), origin: request.origin,
      ...(request.openingMode === undefined ? {} : { openingMode: request.openingMode }),
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }) }
    if (data.authorizationRef !== undefined && (authorization?.kind !== 'authorization/checked' || authorization.data.kind !== 'node-delegation'
      || authorization.data.decision !== 'allowed' || authorization.data.principalId !== data.principalId
      || authorization.data.operationId !== request.operationId || authorization.data.requestDigest !== digest(request)
      || authorization.data.seat !== undefined && authorization.data.seat !== data.seat
      || authorization.data.sourceNodeId !== undefined && authorization.data.sourceNodeId !== data.sourceNodeId)
      || digest(action) !== data.actionDigest || intent?.kind !== 'trigger/accepted'
      || intent.seat !== data.seat || intent.data.trigger.evidence.kind !== 'manual'
      || intent.data.trigger.evidence.operationId !== action.operationId
      || !intent.data.trigger.data || typeof intent.data.trigger.data !== 'object' || Array.isArray(intent.data.trigger.data)
      || !('request' in intent.data.trigger.data) || digest(intent.data.trigger.data.request) !== data.actionDigest) {
      throw new EngineError('engine-store-corrupt', 'Batch member does not match its original authorization and action')
    }
  }
}
