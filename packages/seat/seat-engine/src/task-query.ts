/** Task scans retain the existing engine effect vocabulary and its exclusive cursor semantics. */
import type * as T from '@panedesk/dsh-seat'
import { EngineError } from './journal.ts'
import { queryEngine } from './query.ts'

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
