/** Authorization scans preserve physical journal cursors, including skipped plugin facts. */
import type * as T from '@panedesk/dsh-seat'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { EngineError } from './journal.ts'
import { queryEngine } from './query.ts'

/** Scan the complete committed prefix without deriving attribution from historical principal names.
 * @param decisions - Verified capability-aware frames.
 * @param request - Public filters and exclusive cursor.
 * @param legacy - Exclude plugin attribution from the closed legacy result vocabulary.
 * @returns Matching facts, scan cursor and current committed watermark.
 */
export function queryAuthorizations(decisions: readonly AuthorizationDecision[], request: T.SeatIssuedAuthorizationQueryRequest,
  legacy = false): T.SeatIssuedAuthorizationQueryResult {
  const watermark = decisions.at(-1)?.sequence ?? 0
  const cursor = request.cursor
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request', 'Query limit must be positive')
  if (cursor && (!Number.isSafeInteger(cursor.sequence) || !Number.isSafeInteger(cursor.effectIndex)
    || cursor.sequence < 1 || cursor.sequence > watermark || cursor.effectIndex < 0
    || cursor.nodeId !== decisions[0]?.nodeId
    || cursor.effectIndex >= (decisions.find(item => item.sequence === cursor.sequence)?.effects.length ?? 0))) {
    throw new EngineError('query-cursor-invalid', 'Cursor does not belong to this journal prefix')
  }
  if ([request.from, request.to].some(value => value !== undefined && !Number.isFinite(Date.parse(value)))) {
    throw new EngineError('invalid-request', 'Authorization time filters must be timestamps')
  }
  const facts: T.SeatIssuedAuthorizationFact[] = []
  let nextCursor = cursor
  let legacyAttribution: T.SeatAuthorizationQueryResult['legacyAttribution'] = 'none'
  for (const decision of decisions) {
    if (!decision.effects.some(effect => effect.kind === 'authorization/checked')) legacyAttribution = 'legacy-unknown'
    for (const [effectIndex, effect] of decision.effects.entries()) {
      if (cursor && (decision.sequence < cursor.sequence
        || decision.sequence === cursor.sequence && effectIndex <= cursor.effectIndex)) continue
      if (facts.length === request.limit) return { facts, watermark, complete: false,
        legacyAttribution, ...(nextCursor ? { nextCursor } : {}) }
      nextCursor = { nodeId: decision.nodeId, sequence: decision.sequence, effectIndex }
      if (effect.kind !== 'authorization/checked') continue
      const data = effect.data
      if (legacy && data.kind === 'plugin' || request.kind && request.kind !== data.kind
        || request.nodeId && request.nodeId !== data.nodeId || request.seat && request.seat !== data.seat
        || request.taskId && !data.taskIds.includes(request.taskId)
        || request.from && Date.parse(data.checkedAt) < Date.parse(request.from)
        || request.to && Date.parse(data.checkedAt) >= Date.parse(request.to)) continue
      facts.push(structuredClone(data))
    }
  }
  return { facts, watermark, complete: true, legacyAttribution, ...(nextCursor ? { nextCursor } : {}) }
}
/** Exclude plugin rows rather than misclassifying them or casting them into the legacy kind union.
 * @param decisions - Verified capability-aware frames.
 * @param request - Closed-vocabulary query.
 * @returns Legacy facts with the same scan positions and watermark as the new query.
 */
export function queryLegacyAuthorizations(decisions: readonly AuthorizationDecision[],
  request: T.SeatAuthorizationQueryRequest): T.SeatAuthorizationQueryResult {
  const result = queryAuthorizations(decisions, request, true)
  return { ...result, facts: result.facts.flatMap(data => data.kind === 'plugin' ? [] : [{ ...data, kind: data.kind }]) }
}
/** Task scans retain the existing engine effect vocabulary and its exclusive cursor semantics.
 * @param decisions - Legacy engine projections.
 * @param request - Existing engine filters plus a task association.
 * @returns Each matching effect once, including any related task association.
 */
export function queryTasks(decisions: readonly T.EngineDecision[], request: T.SeatTaskQueryRequest): T.EngineQueryResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request', 'Query limit must be positive')
  if (!request.taskId) return queryEngine(decisions, request)
  const effects: T.EngineEffect[] = []
  let nextCursor = request.cursor
  const watermark = decisions.at(-1)?.sequence ?? 0
  // Validate the shared filters once, even when the journal has no effects.
  queryEngine(decisions.slice(0, 1), { ...request, limit: 1 })
  for (const decision of decisions) {
    if (request.cursor && decision.sequence < request.cursor.sequence) continue
    const selected = new Set(queryEngine([decision], { ...request, limit: Number.MAX_SAFE_INTEGER }).effects)
    for (const [effectIndex, effect] of decision.effects.entries()) {
      if (request.cursor && decision.sequence === request.cursor.sequence && effectIndex <= request.cursor.effectIndex) continue
      if (effects.length === request.limit) return { effects, complete: false, watermark, ...(nextCursor ? { nextCursor } : {}) }
      nextCursor = { nodeId: decision.nodeId, sequence: decision.sequence, effectIndex }
      if (!selected.has(effect)) continue
      const data = effect.data
      const pending = 'pending' in data ? data.pending : undefined
      const tasks = 'relatedTaskIds' in data ? data.relatedTaskIds
        : pending && 'relatedTaskIds' in pending ? pending.relatedTaskIds
          : 'binding' in data && data.binding.kind === 'seat' ? data.binding.relatedTaskIds
            : 'payload' in data ? data.payload.relatedTaskIds : []
      if (effect.taskId === request.taskId || tasks.includes(request.taskId)
        || 'payload' in data && data.payload.taskId === request.taskId) effects.push(effect)
    }
  }
  return { effects, complete: true, watermark, ...(nextCursor ? { nextCursor } : {}) }
}
