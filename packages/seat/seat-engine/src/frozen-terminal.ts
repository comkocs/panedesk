/** Frozen execution queries distinguish original admission receipts from provable pre-open terminals. */
import type * as T from '@panedesk/dsh-seat'
import type { EngineProjection } from './projection.ts'
import type { AuthorizationDecision } from './authorization-storage.ts'
import { digest } from './journal.ts'
import { queryFrozen } from './frozen-admission.ts'

/** Historical evidence can be narrowed by a rebuildable startup index without changing durable fields. */
export type FrozenHistory = Pick<EngineProjection, 'authorizationDecisions' | 'decisions' | 'pending'>

/** Original trigger and route are retained together, never reconstructed from current configuration. */
export interface FrozenItem {
  pending: T.PendingSeatItem
  source: T.TriggerEnvelope
  chain: T.NodeWorkChainAcceptedData
  nodeId: T.SeatNodeId
}
/** A historical cancellation with a unique no-execution reason. */
export interface FrozenTerminal {
  cancellation: Extract<T.EngineEffect, { kind: 'queue/cancelled' }>
  error: T.SeatFailure
}

/** Fixed cancellation reasons exclude operator free text.
 * @returns Existing no-effect rejection reason for an unopened cancellation.
 */
export function preopenCancelledReason(): T.SeatFailure {
  return { code: 'gate-denied', message: 'Pre-open pending item cancelled',
    alternative: 'Query the original operation; prepare and submit a new operation.', retryable: false, effectState: 'none' }
}

/** Recover uniquely paired original admissions from complete frames.
 * @param view - Recovered journal history.
 * @returns Frozen original items; ambiguous pairs are omitted and cannot authorize a terminal.
 */
export function frozenItems(view: FrozenHistory): FrozenItem[] {
  const items: FrozenItem[] = []
  for (const frame of view.authorizationDecisions) {
    for (const effect of frame.effects) {
      if (effect.kind !== 'trigger/accepted' && effect.kind !== 'trigger/coalesced') continue
      const { pending, trigger: source } = effect.data, chain = pending.frozenOpen?.nodeWorkChain
      if (!chain) continue
      const routes = frame.effects.filter(candidate => candidate.kind === 'node-route/accepted'
        && digest(candidate.data) === digest(chain) && candidate.operationId === chain.operationKey.operationId
        && candidate.seat === pending.seat)
      if (routes.length !== 1 || effect.operationId !== chain.operationKey.operationId
        || source.sourceId !== chain.route.sourceId || chain.route.targetNodeId !== frame.nodeId
        || chain.route.triggerId !== null && chain.route.triggerId !== source.triggerId) continue
      items.push({ pending, source, chain, nodeId: frame.nodeId })
    }
  }
  const counts = new Map<T.SeatDigest, number>()
  for (const item of items) {
    const key = digest(item.chain.operationKey)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return items.filter(item => counts.get(digest(item.chain.operationKey)) === 1)
}

/** Match an original source without confusing other operations on the same seat.
 * @param item - Original frozen item.
 * @param source - Historical trigger.
 * @returns Whether both source and trigger identity match.
 */
export function sameFrozenSource(item: FrozenItem, source: Pick<T.TriggerEnvelope, 'sourceId' | 'triggerId'>): boolean {
  return source.sourceId === item.source.sourceId && source.triggerId === item.source.triggerId
}

/** Exclude all historical execution evidence, including already released resources and closed windows.
 * @param view - Complete history, not current resource indexes.
 * @param item - Original item under consideration.
 * @returns Whether execution absence is supported without an ambiguous seat-only fact.
 */
export function hasNoFrozenExecution(view: FrozenHistory, item: FrozenItem): boolean {
  const effects = view.authorizationDecisions.flatMap(frame => frame.effects)
  const opens = effects.filter(effect => effect.kind === 'open/intent' || effect.kind === 'open/created'
    || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed')
  if (opens.some(effect => effect.data.sources?.some(source => sameFrozenSource(item, source))
    || effect.triggerId === item.source.triggerId || effect.operationId === item.chain.operationKey.operationId)) return false
  for (const effect of effects) {
    if (effect.kind === 'queue/cancelled' && effect.data.pending.queueItemId === item.pending.queueItemId) {
      const frame = view.authorizationDecisions.find(frame => frame.effects.includes(effect))
      if (!frame || frame.effects.some(candidate => candidate.kind.startsWith('open/') && candidate.kind !== 'open/rejected'
        || candidate.kind.startsWith('resource/') || candidate.kind.startsWith('window/'))) return false
    }
    if (effect.kind === 'node-wake/updated' && effect.data.original.operationId === item.chain.operationKey.operationId) return false
    if (!effect.kind.startsWith('open/') && !effect.kind.startsWith('resource/') && !effect.kind.startsWith('window/')) continue
    if (effect.kind === 'open/rejected') continue
    if (effect.operationId === item.chain.operationKey.operationId || effect.triggerId === item.source.triggerId) return false
    const seat = effect.seat ?? ('seat' in effect.data ? effect.data.seat : undefined)
    if (seat !== item.pending.seat) continue
    const sessionId = effect.sessionId ?? ('sessionId' in effect.data ? effect.data.sessionId : undefined)
      ?? ('owner' in effect.data ? effect.data.owner.sessionId : undefined)
    // Seat-only execution is ambiguous unless a retained opening attributes it to other sources.
    if (!sessionId || !opens.some(open => open.data.sessionId === sessionId && open.data.sources?.length
      && !open.data.sources.some(source => sameFrozenSource(item, source)))) return false
  }
  return true
}

/** Find any callback stage for this original item, regardless of callback ID or delivery state.
 * @param view - Complete committed callback history.
 * @param item - Original frozen item.
 * @returns Whether a callback already owns its notification.
 */
export function hasFrozenCallback(view: FrozenHistory, item: FrozenItem): boolean {
  return view.decisions.some(frame => frame.effects.some(effect =>
    (effect.kind === 'callback/pending' || effect.kind === 'callback/attempted' || effect.kind === 'callback/delivered')
    && (effect.data.payload.sourceId === item.source.sourceId && effect.data.payload.triggerId === item.source.triggerId
      || effect.data.nodeWorkChain?.route.originalOperationId === item.chain.operationKey.operationId
        && digest(effect.data.nodeWorkChain.route) === digest(item.chain.route))))
}

function terminalReason(frame: AuthorizationDecision, cancelled: FrozenTerminal['cancellation']): T.SeatFailure | undefined {
  const data = cancelled.data, record = data.cancellation
  if (record) {
    const grants = frame.effects.filter(effect => effect.kind === 'authorization/checked'
      && effect.data.authorizationId === record.authorizationId && effect.data.decision === 'allowed'
      && effect.data.principalId === record.principalId && effect.data.kind === record.kind
      && effect.data.operationId === record.operationId && effect.data.seat === data.pending.seat
      && data.pending.relatedTaskIds.every(task => effect.data.taskIds.includes(task)))
    return grants.length === 1 && cancelled.operationId === record.operationId && data.principalId === record.principalId
      && record.queueItemId === data.pending.queueItemId && record.stateVersion === data.revision ? preopenCancelledReason() : undefined
  }
  if (data.principalId !== 'engine-policy') return undefined
  const refusals = frame.effects.filter(effect => effect.kind === 'open/rejected')
  const cancellations = frame.effects.filter(effect => effect.kind === 'queue/cancelled')
  if (cancellations.length !== 1) return undefined
  const refusal = refusals.length === 1 ? refusals[0] : undefined
  if (refusal?.data.error.effectState === 'none' && refusal.seat === data.pending.seat) return refusal.data.error
  return refusals.length === 0 && cancelled.operationId ? preopenCancelledReason() : undefined
}

/** Project only a unique cancelled queue with contiguous versions and no execution facts.
 * @param view - Complete committed history.
 * @param item - Original accepted frozen item.
 * @returns Proven terminal evidence, or absence when still pending, executed or ambiguous.
 */
export function frozenTerminal(view: FrozenHistory, item: FrozenItem): FrozenTerminal | undefined {
  if (view.pending.has(item.pending.queueItemId) || !hasNoFrozenExecution(view, item)) return undefined
  let current: T.PendingSeatItem | undefined, terminal: FrozenTerminal | undefined
  for (const frame of view.authorizationDecisions) {
    for (const effect of frame.effects) {
      const pending = effect.kind === 'queue/pending' ? effect.data
        : effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced' || effect.kind === 'queue/approved'
          ? effect.data.pending : undefined
      if (pending?.queueItemId === item.pending.queueItemId) {
        if (terminal || current && pending.stateVersion !== current.stateVersion + 1) return undefined
        current = pending
      }
      if (effect.kind !== 'queue/cancelled' || effect.data.pending.queueItemId !== item.pending.queueItemId) continue
      if (terminal || !current || effect.data.previousRevision !== current.stateVersion
        || effect.data.revision !== current.stateVersion + 1
        || digest(effect.data.pending.sources) !== digest(current.sources)) return undefined
      const error = terminalReason(frame, effect)
      if (!error) return undefined
      terminal = { cancellation: effect, error }
    }
  }
  return terminal
}

/** Read current pre-open execution outcome while leaving write replays on their first receipt.
 * @param view - Complete recovered projection.
 * @param request - Exact original business key and digest.
 * @returns Existing settled-rejected on proven terminal, otherwise the original query result.
 */
export function queryFrozenExecution(view: EngineProjection, request: T.NodeWorkChainOperationRequest): T.NodeWorkChainOperationResult {
  const original = queryFrozen(view, request)
  if (original.status !== 'settled') return original
  const item = frozenItems(view).find(item => digest(item.chain.operationKey) === digest(request.key))
  const terminal = item && frozenTerminal(view, item)
  if (!terminal) return original
  const result: T.SeatRejected = { status: 'rejected', error: structuredClone(terminal.error) }
  switch (original.method) {
    case 'engine.acceptFrozen': return { status: 'settled', method: original.method, result }
    case 'seat.openFrozen': return { status: 'settled', method: original.method, result }
    case 'seat.wakeFrozen': return { status: 'settled', method: original.method, result }
    default: return original
  }
}
