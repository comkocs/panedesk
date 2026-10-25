/** Wake delivery records retain the authorized input, deterministic action and first receipt. */
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { decodeNodeWorkChainRequest, decodeNodeWorkChainResult } from '@panedesk/dsh-sdk-protocol'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { validAuthorization } from './authorization-storage.ts'
import { digest, EngineError } from './journal.ts'
import { validChainAccepted } from './chain-storage.ts'

/** The action is immutable once its authorization and intent have committed. */
export interface WakeDeliveryRecord {
  method: 'seat.wake' | 'seat.wakeFrozen'
  payload: T.WakeSeatRequest | T.WakeFrozenSeatRequest
  original: T.SeatIssuedAuthorizationFact
  action: { sessionId: SessionId
    operationId: T.SeatOperationId
    text: string
    title: string
    status: 'sent' | 'stored-budget-stopped' }
  result: Extract<T.WakeSeatResult, { status: 'sent' | 'stored-budget-stopped' }> | null
}
/** A private discriminator makes legacy readers refuse the complete frame. */
export interface WakeDeliveryEffect extends T.EngineEffectBase {
  kind: 'node-wake/updated'
  data: WakeDeliveryRecord
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Derive the same delivery identity across retries and process recovery.
 * @param operationId - Original wire operation.
 * @param sessionId - Selected local window.
 * @returns Stable local delivery operation.
 */
export function wakeDeliveryId(operationId: T.SeatOperationId, sessionId: SessionId): T.SeatOperationId {
  return digest(['seat.wake', operationId, sessionId]) as string as T.SeatOperationId
}
/** Keep method and authenticated sender in the retained business identity.
 * @param record - Committed or candidate delivery.
 * @returns Exact business key digest.
 */
export function wakeKey(record: Pick<WakeDeliveryRecord, 'method' | 'payload' | 'original'>): T.SeatDigest {
  const payload = record.payload
  return digest([record.method, record.original.sourceNodeId, record.original.principalId, record.original.operationId,
    'route' in payload ? [payload.route.sourceId, payload.route.ownerEpoch] : null])
}
/** Validate the private record before any recovered action can be sent.
 * @param value - Untrusted persisted record.
 * @returns Whether input, action and receipt retain one immutable identity.
 */
export function validWakeDelivery(value: unknown): value is WakeDeliveryRecord {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'action,method,original,payload,result'
    || !validAuthorization(value.original) || !object(value.payload) || !object(value.action)
    || !['seat.wake', 'seat.wakeFrozen'].includes(String(value.method))) return false
  const original = value.original, action = value.action, payload = value.payload
  if (original.kind !== 'node-delegation' || original.decision !== 'allowed' || !original.sourceNodeId
    || !original.seat || original.requestDigest !== digest(payload)
    || Object.keys(action).sort().join(',') !== 'operationId,sessionId,status,text,title'
    || !id(action.sessionId) || typeof action.text !== 'string' || typeof action.title !== 'string'
    || !['sent', 'stored-budget-stopped'].includes(String(action.status))
    || action.operationId !== wakeDeliveryId(original.operationId, action.sessionId as SessionId)) return false
  const request = value.method === 'seat.wakeFrozen' ? payload.request : payload
  if (!object(request) || !id(request.seat) || request.seat !== original.seat || request.operationId !== original.operationId
    || request.nodeId !== undefined && request.nodeId !== original.nodeId
    || request.sessionId !== undefined && request.sessionId !== action.sessionId
    || Object.keys(request).some(key => !['seat', 'sessionId', 'operationId', 'nodeId'].includes(key))) return false
  if (value.method === 'seat.wakeFrozen' && (!object(payload.route) || !validChainAccepted({
    capability: 'node-work-chain/v1', route: payload.route, openingContext: payload.openingContext,
    expectedSeatRevision: payload.expectedSeatRevision, authorizationRef: original.authorizationId,
    payloadDigest: original.requestDigest, trigger: null, operationKey: { method: 'seat.wakeFrozen',
      operationId: original.operationId, sourceNodeId: original.sourceNodeId, principalId: original.principalId,
      sourceId: payload.route.sourceId, ownerEpoch: payload.route.ownerEpoch },
  }) || payload.route.targetNodeId !== original.nodeId)) return false
  try {
    if (value.method === 'seat.wakeFrozen') decodeNodeWorkChainRequest('seat.wakeFrozen', payload)
    if (value.result !== null) decodeNodeWorkChainResult('seat.wakeFrozen', value.result)
  } catch (_error) { return false }
  if (value.result === null) return true
  return object(value.result) && value.result.status === action.status && value.result.sessionId === action.sessionId
    && value.result.operationId === original.operationId && value.result.title === action.title && id(value.result.messageId)
}
/** Verify the intent's same-frame authorization, without changing route/trigger validation.
 * @param decision - Complete checksummed private frame.
 */
export function validateWakeFrame(decision: AuthorizationDecision): void {
  for (const effect of decision.effects) {
    if (effect.kind !== 'node-wake/updated') continue
    const record = effect.data
    if (!validWakeDelivery(record) || effect.operationId !== record.original.operationId
      || effect.seat !== record.original.seat || effect.sessionId !== record.action.sessionId
      || decision.nodeId !== record.original.nodeId) throw new EngineError('engine-store-corrupt', 'Invalid wake delivery record')
    if (record.result === null && !decision.effects.some(item => item.kind === 'authorization/checked'
      && digest(item.data) === digest(record.original))) {
      throw new EngineError('engine-store-corrupt', 'Wake intent has no matching authorization')
    }
  }
}
/** Fold the sole journal authority into a disposable query view.
 * @param decisions - Recovered private frames.
 * @returns Latest delivery per exact business identity.
 */
export function wakeRecords(decisions: readonly AuthorizationDecision[]): Map<T.SeatDigest, WakeDeliveryRecord> {
  const records = new Map<T.SeatDigest, WakeDeliveryRecord>()
  for (const frame of decisions) for (const effect of frame.effects) {
    if (effect.kind === 'node-wake/updated') records.set(wakeKey(effect.data), effect.data)
  }
  return records
}
/** Reject receipt replacement and changes to a committed delivery before append or replay.
 * @param decisions - Previously committed frames.
 * @param decision - Candidate next frame.
 */
export function validateWakeTransition(decisions: readonly AuthorizationDecision[], decision: AuthorizationDecision): void {
  const records = wakeRecords(decisions)
  for (const effect of decision.effects) {
    if (effect.kind !== 'node-wake/updated') continue
    const record = effect.data, key = wakeKey(record), previous = records.get(key)
    if (!previous && record.result !== null || previous && (previous.result !== null || record.result === null
      || digest({ ...previous, result: null }) !== digest({ ...record, result: null }))) {
      throw new EngineError('state-conflict', 'Wake intent or first receipt cannot be replaced')
    }
    records.set(key, record)
  }
}
