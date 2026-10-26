/** Startup appends missing pre-open notifications without reopening queues or rewriting old frames. */
import { EngineJournal, digest } from './journal.ts'
import { legacyDecision, type AuthorizationDecision } from './authorization-storage.ts'
import { frozenItems, frozenTerminal, hasFrozenCallback, type FrozenItem, type FrozenHistory } from './frozen-terminal.ts'
import { preopenCallback } from './preopen-callback.ts'

/** One startup owns this disposable index; committed history remains the only authority. */
class RecoveryIndex {
  private cursor = 0
  private readonly frames = new Map<string, Set<AuthorizationDecision>>()
  private readonly sessions = new Map<string, Set<AuthorizationDecision>>()
  private add(index: Map<string, Set<AuthorizationDecision>>, key: string, frame: AuthorizationDecision): void {
    let entries = index.get(key)
    if (!entries) { entries = new Set(); index.set(key, entries) }
    entries.add(frame)
  }
  update(journal: EngineJournal): void {
    const history = journal.projection.authorizationDecisions
    for (const frame of history.slice(this.cursor)) {
      this.cursor++
      for (const effect of frame.effects) {
        const keys = new Set<string>()
        if (effect.seat) keys.add(`seat:${effect.seat}`)
        if (effect.operationId) keys.add(`operation:${effect.operationId}`)
        if (effect.triggerId) keys.add(`trigger:${effect.triggerId}`)
        if ('seat' in effect.data) keys.add(`seat:${effect.data.seat}`)
        const pending = effect.kind === 'queue/pending' ? effect.data
          : effect.kind === 'queue/cancelled' || effect.kind === 'queue/approved'
            || effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced' ? effect.data.pending : undefined
        if (pending) { keys.add(`queue:${pending.queueItemId}`); keys.add(`seat:${pending.seat}`) }
        if (effect.kind === 'node-wake/updated') keys.add(`operation:${effect.data.original.operationId}`)
        if (effect.kind === 'callback/pending' || effect.kind === 'callback/attempted' || effect.kind === 'callback/delivered') {
          keys.add(`callback:${effect.data.payload.callbackId}`)
          keys.add(`source:${digest([effect.data.payload.sourceId, effect.data.payload.triggerId])}`)
          if (effect.data.nodeWorkChain) keys.add(`operation:${effect.data.nodeWorkChain.route.originalOperationId}`)
        }
        if (effect.kind === 'open/intent' || effect.kind === 'open/created'
          || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') {
          for (const source of effect.data.sources ?? []) keys.add(`source:${digest([source.sourceId, source.triggerId])}`)
        }
        for (const key of keys) this.add(this.frames, key, frame)
        const sessionId = effect.sessionId ?? ('sessionId' in effect.data ? effect.data.sessionId : undefined)
          ?? ('owner' in effect.data ? effect.data.owner.sessionId : undefined)
        if (sessionId) this.add(this.sessions, sessionId, frame)
      }
    }
  }
  history(journal: EngineJournal, item: FrozenItem): FrozenHistory {
    const frames = new Set<AuthorizationDecision>()
    const callbackId = digest(['seat-preopen-rejected/v1', item.nodeId, item.chain.operationKey,
      item.pending.queueItemId, item.source.sourceId, item.source.triggerId])
    for (const key of [`seat:${item.pending.seat}`, `queue:${item.pending.queueItemId}`,
      `operation:${item.chain.operationKey.operationId}`, `trigger:${item.source.triggerId}`,
      `source:${digest([item.source.sourceId, item.source.triggerId])}`, `callback:${callbackId}`]) {
      for (const frame of this.frames.get(key) ?? []) frames.add(frame)
    }
    // Session-linked facts may omit seat and source; retain their complete frames as well.
    for (const frame of frames) {
      for (const effect of frame.effects) {
        const sessionId = effect.sessionId ?? ('sessionId' in effect.data ? effect.data.sessionId : undefined)
          ?? ('owner' in effect.data ? effect.data.owner.sessionId : undefined)
        if (sessionId) for (const related of this.sessions.get(sessionId) ?? []) frames.add(related)
      }
    }
    const authorizationDecisions = [...frames].sort((a, b) => a.sequence - b.sequence)
    return { authorizationDecisions, decisions: authorizationDecisions.map(legacyDecision), pending: journal.projection.pending }
  }
}

/** Recover eligible historical cancellations before readiness and scheduling.
 * @param journal - Fully recovered journal with its sole writer acquired.
 * @param nodeName - Executing node display name used for new notifications.
 * @returns Number of ambiguous terminal candidates left unchanged for operator review.
 */
export async function recoverPreopenCallbacks(journal: EngineJournal, nodeName: string): Promise<number> {
  const index = new RecoveryIndex()
  index.update(journal)
  const candidates = frozenItems(journal.projection)
  let ambiguous = 0
  for (const item of candidates) {
    await journal.commit(() => {
      index.update(journal)
      const view = index.history(journal, item)
      if (view.pending.has(item.pending.queueItemId) || hasFrozenCallback(view, item)) return []
      const terminal = frozenTerminal(view, item)
      if (!terminal) { ambiguous++; return [] }
      return preopenCallback(view, item, terminal.cancellation, terminal.error, nodeName, new Date().toISOString())
    })
  }
  return ambiguous
}
