/** Authorization-capable frames retain legacy effects without widening their closed vocabulary. */
import { SEAT_AUTHORIZATION_CAPABILITY, SEAT_AUTHORIZATION_EVENT_NAME } from '@panedesk/dsh-seat'
import type * as T from '@panedesk/dsh-seat'
import { canonical, decodeFrame, digest, EngineError, frame } from './journal.ts'

/** A required discriminator makes older readers refuse the complete decision. */
export interface AuthorizationEffect extends T.EngineEffectBase {
  kind: typeof SEAT_AUTHORIZATION_EVENT_NAME
  capability: typeof SEAT_AUTHORIZATION_CAPABILITY
  data: T.SeatIssuedAuthorizationFact
}
/** Both effect families occupy one checksummed, synchronized journal frame. */
export interface AuthorizationDecision extends Omit<T.EngineDecision, 'effects'> {
  effects: readonly (T.EngineEffect | AuthorizationEffect)[]
}
/** Validate attribution at the durable JSON boundary, including unknown-field rejection.
 * @param value - Untrusted persisted attribution.
 * @returns Whether every retained field belongs to the public fact schema.
 */
export function validAuthorization(value: unknown): value is T.SeatIssuedAuthorizationFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  const required = ['authorizationId', 'principalId', 'nodeId', 'operationId', 'reasonCode', 'requestDigest', 'checkedAt']
  const optional = ['sessionId', 'seat', 'callId', 'rootCallId', 'delegatedBy']
  return Object.keys(data).every(key => [...required, ...optional, 'kind', 'origin', 'taskIds', 'policyRevision', 'decision'].includes(key))
    && required.every(key => typeof data[key] === 'string' && data[key] !== '')
    && optional.every(key => data[key] === undefined || typeof data[key] === 'string' && data[key] !== '')
    && ['model-tool-call', 'human', 'engine', 'local-operator', 'node-delegation', 'plugin'].includes(String(data.kind))
    && ['manual', 'engine', 'remote'].includes(String(data.origin))
    && ['allowed', 'denied'].includes(String(data.decision))
    && Number.isSafeInteger(data.policyRevision) && Number(data.policyRevision) >= 0
    && Array.isArray(data.taskIds) && data.taskIds.every(id => typeof id === 'string' && id !== '')
    && new Set(data.taskIds).size === data.taskIds.length
    && Number.isFinite(Date.parse(String(data.checkedAt)))
    && (data.kind !== 'model-tool-call' || typeof data.sessionId === 'string' && typeof data.callId === 'string')
}
/** Encode the expanded frame without changing the engine namespace or version.
 * @param input - Complete semantic fields.
 * @returns Checksummed durable frame.
 */
export function authorizationFrame(input: Omit<AuthorizationDecision, 'digest' | 'byteLength'>): AuthorizationDecision {
  return { ...input, digest: digest(input), byteLength: Buffer.byteLength(canonical(input)) }
}
/** Preserve the original legacy projection and export vocabulary.
 * @param decision - Verified expanded decision.
 * @returns A legacy-only projection, with an independently valid export checksum.
 */
export function legacyDecision(decision: AuthorizationDecision): T.EngineDecision {
  const { digest: _digest, byteLength: _length, ...body } = decision
  const effects = body.effects.filter((effect): effect is T.EngineEffect => effect.kind !== SEAT_AUTHORIZATION_EVENT_NAME)
  return frame({ ...body, effects })
}
/** Decode required authorization events before allowing any projection mutation.
 * @param text - Complete frame bytes without newline.
 * @param maxBytes - Complete-frame bound.
 * @returns Verified expanded decision; old decodeFrame still refuses this discriminator.
 */
export function decodeAuthorizationFrame(text: string, maxBytes: number): AuthorizationDecision {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || !('effects' in parsed) || !Array.isArray(parsed.effects)
    || !parsed.effects.some((effect: unknown) => effect !== null && typeof effect === 'object'
      && 'kind' in effect && effect.kind === SEAT_AUTHORIZATION_EVENT_NAME)) return decodeFrame(text, maxBytes)
  if (Buffer.byteLength(text) + 1 > maxBytes) throw new EngineError('engine-store-corrupt', 'Authorization frame exceeds its byte limit')
  const decision = parsed as AuthorizationDecision
  const { digest: checksum, byteLength, ...body } = decision
  if (digest(body) !== checksum || Buffer.byteLength(canonical(body)) !== byteLength) {
    throw new EngineError('engine-store-corrupt', 'Authorization frame checksum mismatch')
  }
  const ids = new Set<string>()
  const persistedEffects: readonly unknown[] = parsed.effects
  for (const effect of persistedEffects) {
    if (!effect || typeof effect !== 'object' || !('eventId' in effect)
      || typeof effect.eventId !== 'string' || !effect.eventId || ids.has(effect.eventId)) {
      throw new EngineError('engine-store-corrupt', 'Invalid or duplicate authorization effect identity')
    }
    ids.add(effect.eventId)
    const fields = effect as Record<string, unknown>
    if (fields.kind !== SEAT_AUTHORIZATION_EVENT_NAME) continue
    if (fields.capability !== SEAT_AUTHORIZATION_CAPABILITY || !validAuthorization(fields.data)
      || fields.data.nodeId !== decision.nodeId || fields.operationId !== fields.data.operationId
      || fields.seat !== fields.data.seat || fields.sessionId !== fields.data.sessionId) {
      throw new EngineError('engine-store-corrupt', 'Invalid authorization attribution or capability')
    }
  }
  const legacy = legacyDecision(decision)
  // A denied fact has no business effects; a synthetic validation effect checks only the header.
  const { digest: _legacyDigest, byteLength: _legacyLength, ...legacyBody } = legacy
  const validation = legacy.effects.length ? legacy : frame({ ...legacyBody, effects: [{ kind: 'memory/audit',
    eventId: 'validation' as T.EngineEventId, data: { sessionId: 'validation' as T.EngineMemoryAuditData['sessionId'],
      paths: [], attribution: 'unknown', complete: true, reason: null } }] })
  decodeFrame(canonical(validation), Math.max(maxBytes, Buffer.byteLength(canonical(validation)) + 1))
  return decision
}
