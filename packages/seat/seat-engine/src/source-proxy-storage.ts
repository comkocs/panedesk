/** Outgoing frozen intents use required journal effects and retain unknown reservations on replay. */
import type * as T from '@panedesk/dsh-seat'
import { decodeNodeWorkChainRequest, decodeNodeWorkChainResult } from '@panedesk/dsh-sdk-protocol'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { validAuthorization } from './authorization-storage.ts'
import { validChainAccepted } from './chain-storage.ts'
import { digest, EngineError } from './journal.ts'
import type { SourceProxyRecord } from './source-proxy-types.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Decode complete source records before publishing any recovered state.
 * @param value - Untrusted journal data.
 * @returns Whether identity, frozen evidence and result state agree.
 */
export function validSourceProxy(value: unknown): value is SourceProxyRecord {
  if (!object(value) || !object(value.payload) || !object(value.input) || !object(value.operationKey)
    || !object(value.outcome) || !validAuthorization(value.original)
    || Object.keys(value).sort().join(',') !== 'input,inputDigest,method,operationKey,original,outcome,payload,payloadDigest,targetNodeId'
    || !['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'].includes(String(value.method))) return false
  const payload = value.payload, key = value.operationKey, original = value.original
  if (original.kind === 'node-delegation' || original.decision !== 'allowed'
    || value.inputDigest !== digest(value.input) || original.requestDigest !== value.inputDigest
    || value.payloadDigest !== digest(payload) || key.sourceNodeId !== original.nodeId
    || key.principalId !== original.principalId || key.operationId !== original.operationId || key.method !== value.method
    || !object(payload.route) || payload.route.sourceOwnerNodeId !== original.nodeId
    || payload.route.targetNodeId !== value.targetNodeId || value.targetNodeId === original.nodeId
    || !validChainAccepted({ capability: 'node-work-chain/v1', route: payload.route,
      openingContext: payload.openingContext, expectedSeatRevision: payload.expectedSeatRevision,
      authorizationRef: original.authorizationId, payloadDigest: value.payloadDigest, operationKey: key,
      trigger: value.method === 'engine.acceptFrozen' ? payload.envelope : null })) return false
  const target = value.method === 'engine.acceptFrozen' ? payload.envelope : payload.request
  if (!object(target) || target.seat !== original.seat || !object(payload.openingContext)
    || !object(payload.openingContext.snapshot) || !Array.isArray(payload.openingContext.snapshot.taskIds)
    || payload.openingContext.snapshot.taskIds.some(task => !original.taskIds.includes(task as T.SeatTaskId))) return false
  if (value.method === 'engine.acceptFrozen') {
    if (digest(target) !== value.inputDigest) return false
  } else {
    const { openingContext, relatedTaskIds, ...request } = value.input
    if (digest(target) !== digest(request) || target.operationId !== original.operationId
      || !object(openingContext) || digest(openingContext) !== digest(payload.openingContext.snapshot.reference)
      || !Array.isArray(relatedTaskIds)
      || digest(relatedTaskIds.toSorted()) !== digest(payload.openingContext.snapshot.taskIds.toSorted())) return false
  }
  const method = value.method as T.SeatRemoteOpeningMethod
  try { decodeNodeWorkChainRequest(method, payload) } catch (_error) { return false }
  const outcome = value.outcome
  if (outcome.status === 'unknown') return Object.keys(outcome).length === 1
  if (!object(outcome.result) || Object.keys(outcome).sort().join(',') !== 'result,status') return false
  let result: T.NodeWorkChainMethodMap[T.SeatRemoteOpeningMethod]['result']
  try { result = decodeNodeWorkChainResult(method, outcome.result) } catch (_error) { return false }
  return outcome.status === 'rejected' ? result.status === 'rejected' && result.error.effectState === 'none'
    : outcome.status === 'committed' && result.status !== 'rejected'
}
/** Check each outgoing effect against the source journal owner.
 * @param decision - Checksum-verified expanded journal frame.
 */
export function validateSourceProxyFrame(decision: AuthorizationDecision): void {
  for (const effect of decision.effects) {
    if (effect.kind !== 'node-source/updated') continue
    if (!validSourceProxy(effect.data) || effect.operationId !== effect.data.operationKey.operationId
      || effect.seat !== effect.data.original.seat || decision.nodeId !== effect.data.operationKey.sourceNodeId) {
      throw new EngineError('engine-store-corrupt', 'Invalid outgoing frozen intent')
    }
  }
}
/** Recover the latest record from the existing journal, without a second authority store.
 * @param decisions - Recovered source decisions in sequence order.
 * @returns Latest durable record per complete business key.
 */
export function sourceProxyRecords(decisions: readonly AuthorizationDecision[]): Map<string, SourceProxyRecord> {
  const records = new Map<string, SourceProxyRecord>()
  for (const decision of decisions) for (const effect of decision.effects) {
    if (effect.kind === 'node-source/updated') records.set(digest(effect.data.operationKey), effect.data)
  }
  return records
}
/** Refuse changes to a reserved payload or terminal result before append and during replay.
 * @param decisions - Previously committed records.
 * @param decision - Next candidate decision.
 */
export function validateSourceProxyTransition(decisions: readonly AuthorizationDecision[], decision: AuthorizationDecision): void {
  const records = sourceProxyRecords(decisions)
  for (const effect of decision.effects) {
    if (effect.kind !== 'node-source/updated') continue
    const data = effect.data, key = digest(data.operationKey), previous = records.get(key)
    const { outcome: _outcome, ...intent } = data
    if (previous) {
      const { outcome, ...retained } = previous
      if (digest(intent) !== digest(retained) || outcome.status !== 'unknown' && digest(outcome) !== digest(data.outcome)) {
        throw new EngineError('operation-id-conflict', 'Outgoing frozen intent or terminal result changed')
      }
    } else if (data.outcome.status !== 'unknown') throw new EngineError('engine-store-corrupt', 'Outgoing result has no reserved intent')
    records.set(key, data)
  }
}
