/** Execution refusals and retention clocks derive only from committed queue facts. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'

/** Fixed categories contain no provider messages or private source text. */
export type TransientCategory = 'provider-unavailable' | 'scope-unknown' | 'scope-conflict'

/** Classify a completed trusted qualification check without treating uncertainty as revocation.
 * @param refusal - Policy refusal, or permission to continue.
 * @returns Permission, permanent refusal, or a fixed transient category.
 */
export function classifyRecheck(refusal: T.SeatRejected | null): 'allowed' | 'terminal' | TransientCategory {
  if (!refusal) return 'allowed'
  if (!refusal.error.retryable && refusal.error.effectState === 'none') return 'terminal'
  const code = refusal.error.cause?.code
  return code === 'scope-unknown' || code === 'scope-conflict' ? code : 'provider-unavailable'
}

/** Recognize a committed transient marker, excluding the initial empty scheduling placeholder.
 * @param item - Committed queue state.
 * @returns Its fixed category, if present.
 */
export function transientCategory(item: T.PendingSeatItem): TransientCategory | undefined {
  const category = item.blockedBy[0]
  return item.reason === 'provider-unavailable' && item.blockedBy.length === 1
    && (category === 'provider-unavailable' || category === 'scope-unknown' || category === 'scope-conflict') ? category : undefined
}

/** Fold the current continuous retention segment in frame and effect order.
 * @param view - Complete recovered history.
 * @param queueItemId - Original queue identity.
 * @returns First committed observation time of the current category, never the last retry time.
 */
export function retentionSince(view: EngineProjection, queueItemId: T.QueueItemId): number | undefined {
  let category: TransientCategory | undefined, since: number | undefined
  for (const frame of view.decisions) {
    for (const effect of frame.effects) {
      if (effect.kind === 'queue/cancelled' && effect.data.pending.queueItemId === queueItemId) {
        category = undefined; since = undefined
        continue
      }
      const item = effect.kind === 'queue/pending' ? effect.data
        : effect.kind === 'queue/approved' || effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced'
          ? effect.data.pending : undefined
      if (!item || item.queueItemId !== queueItemId) continue
      const next = transientCategory(item)
      if (next !== category) { category = next; since = next ? Date.parse(frame.observedAt) : undefined }
    }
  }
  return since
}
