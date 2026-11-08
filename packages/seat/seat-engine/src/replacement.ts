/** Replacement retains the old owner until a confirmed first reply and flushed close. */
import { randomUUID } from 'node:crypto'
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, EngineError, digest } from './journal.ts'
import { fact, rejected } from './triggers.ts'
import { closeEffects } from './closing.ts'

/** Project a durable replacement transaction for callers.
 * @param data - current transaction.
 * @returns observable queue, progress or failure.
 */
export function replacementResult(data: T.EngineReplacementData): T.ReplaceSeatResult {
  if (data.phase === 'queued' && data.pending) return { status: 'queued', replacementId: data.replacementId,
    oldSessionId: data.oldSessionId, phase: 'queued', queueItemId: data.pending.queueItemId,
    sequence: data.pending.sequence, reason: data.pending.reason }
  if (data.phase === 'failed' && data.failure) return { status: 'failed', replacementId: data.replacementId,
    oldSessionId: data.oldSessionId, newSessionId: data.newSessionId, phase: 'failed',
    reason: data.failure.code === 'replacement-first-turn-failed' ? 'replacement-first-turn-failed' : 'replacement-open-failed',
    cause: data.failure, cleanup: data.cleanup ?? (data.newSessionId ? 'pending' : 'not-created') }
  if (data.newSessionId && data.permit && data.phase !== 'failed' && data.phase !== 'queued') return {
    status: 'replacing', replacementId: data.replacementId, oldSessionId: data.oldSessionId,
    newSessionId: data.newSessionId, phase: data.phase, permit: data.permit,
  }
  return rejected('unavailable', 'Replacement state is unavailable')
}

/** Retain one queue identity per caller operation without acquiring resources.
 * @param journal - node writer.
 * @param request - old Session and stable operation.
 * @returns committed transaction or refusal.
 */
export async function queueReplacement(journal: EngineJournal, request: T.ReplaceSeatRequest,
): Promise<T.ReplaceSeatResult> {
  let result: T.ReplaceSeatResult = rejected('session-not-found', 'Old window is not active')
  await journal.commit((view) => {
    const duplicate = [...view.replacements.values()].find(item => item.operationId === request.operationId)
    if (duplicate) {
      result = duplicate.oldSessionId === request.sessionId ? replacementResult(duplicate)
        : rejected('operation-id-conflict', 'Replacement operation belongs to another window')
      return []
    }
    const old = view.opens.get(request.sessionId)
    if (!old || old.binding.kind !== 'seat' || !view.resources.has(request.sessionId)) return []
    if ([...view.replacements.values()].some(item => item.oldSessionId === request.sessionId
      && item.phase !== 'completed' && item.phase !== 'failed')) {
      result = rejected('state-conflict', 'A replacement already owns this window'); return []
    }
    const replacementId = randomUUID() as T.ReplacementId
    const pending: T.PendingSeatItem = { queueItemId: randomUUID() as T.QueueItemId, seat: old.binding.seat,
      projectId: old.binding.projectId, triggerKind: 'manual', action: 'replace', replacementId,
      sequence: view.sequence + 1, effectiveMode: 'auto', reason: 'provider-unavailable', blockedBy: [],
      sources: old.sources ?? [], relatedTaskIds: old.binding.relatedTaskIds, queuedAt: new Date().toISOString(), stateVersion: 1 }
    const data: T.EngineReplacementData = { replacementId, operationId: request.operationId, oldSessionId: request.sessionId,
      newSessionId: null, phase: 'queued', permit: null, openingMessageId: null, firstTurn: null, pending, failure: null }
    result = replacementResult(data)
    return [fact({ kind: 'window/replacement', operationId: request.operationId, data }), fact({ kind: 'queue/pending', data: pending })]
  })
  return result
}

/** Reconcile only original replacement Sessions, never minting another on retry. */
export class ReplacementDriver {
  constructor(private readonly journal: EngineJournal, private readonly seats: () => Pick<T.SeatService, 'list' | 'close'> | undefined,
    private readonly nodeName: string,
    private readonly freezeCallbacks?: (deliveries: readonly T.SeatCallbackDelivery[]) => Promise<T.SeatCallbackDelivery[]>) {}

  private async prepareCallbacks(effects: readonly T.EngineEffect[]): Promise<readonly T.EngineEffect[]> {
    if (!this.freezeCallbacks) return effects
    const deliveries = await this.freezeCallbacks(effects.flatMap(effect => effect.kind === 'callback/pending' ? [effect.data] : []))
    return effects.map((effect) => {
      if (effect.kind !== 'callback/pending') return effect
      const data = deliveries.find(item => item.payload.callbackId === effect.data.payload.callbackId)
      if (!data) throw new EngineError('state-conflict', 'Replacement callback evidence is unavailable')
      return { ...effect, data }
    })
  }

  /** Observe first-turn evidence and close only the selected side of the handover.
   * @param executor - installed original-open executor.
   */
  async drive(executor: T.SeatOpenExecutor): Promise<void> {
    for (const initial of [...this.journal.projection.replacements.values()]) {
      if (!initial.newSessionId || !initial.permit || initial.phase === 'completed' || initial.phase === 'failed') continue
      let current = initial
      const open = this.journal.projection.opens.get(initial.newSessionId)
      if (!open) continue
      if (open.phase === 'opening-failed' && !current.failure) {
        current = { ...current, phase: 'closing-new', failure: open.failure?.code === 'replacement-open-failed' ? open.failure : rejected(
          'replacement-first-turn-failed', 'Replacement first turn failed').error,
        permit: { ...initial.permit, state: 'expired-failure', expiredAt: new Date().toISOString() } }
        await this.publish(current)
      } else if (!current.failure && current.permit?.state !== 'expired-success') {
        const firstTurn = await executor.replacementFirstTurn?.(open)
        if (!firstTurn || firstTurn.messageId !== open.openingMessageId) continue
        const succeeded = firstTurn.completed && firstTurn.hasAssistantReply
        current = { ...current, phase: succeeded ? 'awaiting-old-idle' : 'closing-new', firstTurn,
          openingMessageId: open.openingMessageId,
          failure: succeeded ? null : rejected('replacement-first-turn-failed',
            firstTurn.completed ? 'Replacement first turn completed without an assistant reply' : 'Replacement first turn did not complete').error,
          permit: { ...initial.permit, state: succeeded ? 'expired-success' : 'expired-failure', expiredAt: new Date().toISOString() } }
        await this.publish(current)
      }
      if (current.failure && await executor.observe(open) === 'absent') {
        const failed: T.EngineReplacementData = { ...current, phase: 'failed', cleanup: 'not-created' }
        const routed = this.journal.projection.authorizationDecisions.some(frame => frame.effects.some(effect => effect.kind === 'node-route/accepted'))
        const callbacks = routed ? await this.prepareCallbacks(this.failedCallbacks(failed,
          this.journal.projection.opens.get(current.oldSessionId))) : undefined
        await this.journal.commit((view) => {
          const resource = view.resources.get(open.sessionId)
          return [fact({ kind: 'window/replacement', data: failed }),
            ...(resource ? [fact({ kind: 'resource/released', sessionId: open.sessionId, data: {
              owner: resource.owner, reason: 'open-aborted', observedAt: new Date().toISOString(),
              releasedAt: new Date().toISOString(), engineReadyAt: null, fenced: true,
            } })] : []), ...(callbacks ?? this.failedCallbacks(failed, view.opens.get(current.oldSessionId)))]
        })
        continue
      }
      if (current.failure || current.permit?.state === 'expired-success') await this.finish(current)
    }
  }
  private async publish(data: T.EngineReplacementData): Promise<void> {
    await this.journal.commit(() => [fact({ kind: 'window/replacement', data })])
  }
  private async finish(current: T.EngineReplacementData): Promise<void> {
    const target = current.failure ? current.newSessionId : current.oldSessionId
    if (!target) return
    const seats = this.seats()
    if (!seats) return
    let closed = this.journal.projection.closed.get(target)
    if (!closed) {
      const page = await seats.list({})
      if (page.status !== 'listed') return
      const window = page.sessions.find(item => item.sessionId === target)
      if (!window || window.evidence !== 'complete' || window.busyReasons.length) return
      const result = await seats.close({ sessionId: target, expectedStateVersion: window.stateVersion,
        operationId: `replace-close:${current.replacementId}:${target}` as T.SeatOperationId })
      if (result.status !== 'closed') return
      closed = this.journal.projection.closed.get(target) ?? { sessionId: target, phase: 'closed',
        operationId: `replace-close:${current.replacementId}:${target}` as T.SeatOperationId,
        reason: current.failure ? 'replacement-failed' : 'replaced', stateVersion: result.stateVersion,
        endedAt: result.endedAt, reportId: null, selfReport: null, selfReportStatus: 'not-submitted' }
    }
    const terminal = closed
    const settled: T.EngineReplacementData = { ...current, phase: current.failure ? 'failed' : 'completed', cleanup: 'closed' }
    const routed = this.journal.projection.authorizationDecisions.some(frame => frame.effects.some(effect => effect.kind === 'node-route/accepted'))
    const prepared = routed ? await this.prepareCallbacks([
      ...closeEffects(this.journal.projection, terminal, this.nodeName),
      ...(current.failure ? this.failedCallbacks(settled, this.journal.projection.opens.get(current.oldSessionId)) : []),
    ]) : undefined
    await this.journal.commit((view) => {
      const effects = closeEffects(view, terminal, this.nodeName).map((effect) => {
        if (!prepared || effect.kind !== 'callback/pending') return effect
        const retained = prepared.find(item => item.kind === 'callback/pending'
          && item.data.payload.callbackId === effect.data.payload.callbackId)
        if (!retained) throw new EngineError('state-conflict', 'Replacement callback changed during evidence capture')
        return retained
      })
      effects.push(fact({ kind: 'window/replacement', data: settled }))
      if (current.failure) effects.push(...(prepared
        ? prepared.filter(effect => effect.kind === 'callback/pending' && effect.data.payload.kind === 'replacement-failed')
        : this.failedCallbacks(settled, view.opens.get(current.oldSessionId))))
      return effects
    })
  }
  private failedCallbacks(current: T.EngineReplacementData, open: T.EngineOpenData | undefined): T.EngineEffect[] {
    if (!open || open.binding.kind !== 'seat' || !current.failure) return []
    const binding = open.binding, failure = current.failure
    return (open.sources ?? []).map((source) => {
      const payload: T.SeatCallbackPayload = { kind: 'replacement-failed',
        callbackId: digest([current.replacementId, source.triggerId, 'failed']) as string as T.CallbackId,
        sourceId: source.sourceId, triggerId: source.triggerId, stateVersion: this.journal.projection.sequence + 1,
        seat: binding.seat, title: open.title ?? binding.seat, sessionId: open.sessionId,
        nodeId: binding.nodeId, nodeName: this.nodeName, budget: open.budget.limits,
        ...(source.taskId ? { taskId: source.taskId } : {}), relatedTaskIds: binding.relatedTaskIds,
        replacementId: current.replacementId, oldSessionId: current.oldSessionId, newSessionId: current.newSessionId,
        reason: failure.code === 'replacement-first-turn-failed' ? 'replacement-first-turn-failed' : 'replacement-open-failed',
        cause: failure, cleanup: current.cleanup ?? (current.newSessionId ? 'pending' : 'not-created') }
      return fact({ kind: 'callback/pending', data: { payload, payloadDigest: digest(payload), attempt: 0,
        phase: 'pending', nextDue: null, responseClass: null } })
    })
  }
}
