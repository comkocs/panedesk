/** Offline gate projections consume verified engine facts without activating policy drivers. */
import type { Context } from '@panedesk/cordis'
import { SeatGatesQueryService } from '@panedesk/dsh-seat'
import type { EngineEffect, ListSeatGatesRequest, SeatGateQuerySnapshot, SeatRejected } from '@panedesk/dsh-seat'

/** Loader identity for the read-only gate projection. */
export const name = 'seat-gates-query'
/** The reader activates only while an independently mounted engine reader is available. */
export const inject: string[] = []

function refusal(code: 'invalid-request' | 'query-cursor-invalid' | 'unavailable'): SeatRejected {
  return { status: 'rejected', error: { code, message: 'The gate query cannot read the requested snapshot.',
    alternative: 'Read the available engine journal again without a cursor.', retryable: code !== 'invalid-request', effectState: 'none' } }
}
function limitEvidence(effect: Extract<EngineEffect, { kind: 'gate/hit' }>): SeatGateQuerySnapshot['limit'] {
  const { context, definition } = effect.data
  const tree = context.worktreeFacts
  if (definition.criterion.type === 'worktree-client' && tree?.event === 'register' && tree.requestedKind === 'client') {
    return { value: tree.clientTreeLimit, observed: tree.clientTreeCount,
      status: tree.clientTreeCount >= tree.clientTreeLimit ? 'reached' : 'below' }
  }
  return { status: 'unknown', value: null, observed: null }
}

class GateReader extends SeatGatesQueryService {
  async list(request: ListSeatGatesRequest) {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) return refusal('invalid-request')
    const engine = this.ctx.get('seatEngineQuery')
    if (!engine) return refusal('unavailable')
    // One engine observation pins counters and pagination to the same verified prefix.
    const page = await engine.query({ kinds: ['gate/hit', 'gate/expired'], limit: Number.MAX_SAFE_INTEGER })
    if ('status' in page) return page
    const cursor = request.cursor
    if (cursor && (cursor.nodeId !== page.nextCursor?.nodeId || cursor.sequence !== page.watermark
      || !Number.isSafeInteger(cursor.effectIndex) || cursor.effectIndex < 0)) return refusal('query-cursor-invalid')
    const snapshots = new Map<string, SeatGateQuerySnapshot>()
    const now = Date.now()
    for (const effect of page.effects) {
      if (effect.kind !== 'gate/hit' && effect.kind !== 'gate/expired') continue
      const { definition } = effect.data
      const key = JSON.stringify([definition.id, definition.revision])
      let row = snapshots.get(key)
      if (!row) {
        row = { definition, hitCount: 0, lastHitAt: null, expired: false, watermark: page.watermark,
          limit: { status: 'unknown', value: null, observed: null } }
        snapshots.set(key, row)
      }
      row.definition = definition
      row.expired ||= definition.expiresAt !== null && now >= Date.parse(definition.expiresAt)
      if (effect.kind === 'gate/expired') {
        row.expired = true
        row.hitCount = Math.max(row.hitCount, effect.data.hitCount)
      } else {
        row.hitCount = Math.max(row.hitCount, effect.data.result.hitCount)
        row.lastHitAt = effect.data.context.observedAt
        row.limit = limitEvidence(effect)
      }
    }
    const rows = [...snapshots.values()].filter(row =>
      (request.gateId === undefined || row.definition.id === request.gateId)
      && (request.hook === undefined || row.definition.hook === request.hook))
      .sort((a, b) => a.definition.id.localeCompare(b.definition.id) || a.definition.revision - b.definition.revision)
    const start = cursor ? cursor.effectIndex + 1 : 0
    if (cursor && start > rows.length) return refusal('query-cursor-invalid')
    const gates = rows.slice(start, start + request.limit)
    const end = start + gates.length
    return { gates, watermark: page.watermark, complete: page.complete && end >= rows.length,
      ...(end < rows.length && page.nextCursor ? { nextCursor: {
        nodeId: page.nextCursor.nodeId, sequence: page.watermark, effectIndex: end - 1,
      } } : {}) }
  }
}

/** Install only a disposable read-only projection; no files or runtime services are created.
 * @param ctx - owner of the optional engine-reader subscription.
 */
export function apply(ctx: Context): void {
  ctx.inject(['seatEngineQuery'], (scope) => { scope.plugin(GateReader) })
}
