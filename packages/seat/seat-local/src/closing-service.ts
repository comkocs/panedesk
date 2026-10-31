/** Local close barriers retain archive recovery and publish only flushed terminal facts. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { LocalEngineState, localFact } from './engine-state.ts'
import { latestReport } from './report-store.ts'
import { createCloseExecutor } from './close-executor.ts'
import { readWindowStatus } from './status.ts'
import { rejected } from './errors.ts'
import { digest } from './store.ts'
import { withdrawOrphanedOpening } from './orphaned-opening.ts'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'

/** Last committed close state, including a released pre-archive barrier.
 * @param effects - committed engine facts in journal order.
 * @param sessionId - window whose close state is requested.
 * @returns latest close state, or undefined when no close was committed.
 */
export function closingState(effects: readonly T.EngineEffect[], sessionId: SessionId): T.EngineCloseData | undefined {
  const last = effects.findLast(effect => (effect.kind === 'window/closing' || effect.kind === 'window/closed')
    && effect.data.sessionId === sessionId)
  return last?.kind === 'window/closing' || last?.kind === 'window/closed' ? last.data : undefined
}

/** Per-provider serialization complements journal CAS against report revocation. */
export class LocalCloser {
  private readonly running = new Map<SessionId, Promise<T.CloseSeatResult>>()
  constructor(private readonly ctx: Context, private readonly state: LocalEngineState,
    private readonly runtime: LocalSeatRuntime, private readonly options: LocalSeatOptions) {}

  /** Close under a durable barrier, preserving failed post-archive work for replay.
   * @param request - stable operation and observed window revision.
   * @param report - optional exact self-report authorization.
   * @param authorization - Optional issued grant; omission retains the legacy close path.
   * @returns flushed close, busy evidence or version conflict.
   */
  close(request: T.CloseSeatRequest, report?: T.CloseSelfReport, authorization?: T.SeatAuthorizationGrant): Promise<T.CloseSeatResult> {
    const previous = this.running.get(request.sessionId)
    if (previous) return previous.then(() => this.close(request, report, authorization))
    const work = this.run(request, report, authorization).finally(() => { this.running.delete(request.sessionId) })
    this.running.set(request.sessionId, work)
    return work
  }
  private async run(request: T.CloseSeatRequest, report?: T.CloseSelfReport,
    authorization?: T.SeatAuthorizationGrant): Promise<T.CloseSeatResult> {
    const engine = this.ctx.get('seatEngine')
    if (!engine) return rejected('unavailable', 'Close accounting is unavailable.', 'Restore the engine.')
    const transactions = this.ctx.get('seatAuthorizationTransactions')
    if (authorization && !transactions?.validate) return rejected('unavailable', 'Audited close is unavailable.', 'Restore authorization admission.')
    const validate = async () => authorization && transactions?.validate ? transactions.validate({
      operationId: request.operationId, requestDigest: digest(request),
      ...(authorization.fact.callId ? { callId: authorization.fact.callId } : {}),
      ...(authorization.fact.rootCallId ? { rootCallId: authorization.fact.rootCallId } : {}),
    }, authorization) : null
    const refusal = await validate()
    if (refusal) return refusal
    if (!this.ctx.get('agents')?.get(request.sessionId)) {
      const effects = (await this.state.read()).effects
      const opened = effects.findLast(effect => (effect.kind === 'open/created' || effect.kind === 'open/configured'
        || effect.kind === 'open/opening-failed') && effect.data.sessionId === request.sessionId)
      const released = effects.some(effect => effect.kind === 'resource/released'
        && effect.data.owner.sessionId === request.sessionId
        && (effect.data.reason === 'holder-death' || effect.data.reason === 'host-restart-recovery'))
      if (opened && released && closingState(effects, request.sessionId)?.phase !== 'closed') {
        const controller = this.ctx.get('sessionController')
        if (!controller) return rejected('unavailable', 'Session recovery is unavailable.', 'Restore the session controller.')
        const resumed = await controller.resolveAgent(request.sessionId)
        if ('error' in resumed) return rejected('owner-unknown', 'Session ownership could not be acquired.', 'Inspect the existing Session owner before retrying.')
      }
    }
    let initial = await this.runtime.evidence(request.sessionId)
    if (initial.stateVersion === request.expectedStateVersion) {
      const effects = (await this.state.read()).effects
      const old = closingState(effects, request.sessionId)
      const opened = effects.findLast(effect => (effect.kind === 'open/created' || effect.kind === 'open/configured')
        && effect.data.sessionId === request.sessionId)
      const binding = opened?.kind === 'open/created' || opened?.kind === 'open/configured' ? opened.data.binding : undefined
      const authorized = !authorization || binding?.kind === 'seat' && binding.seat === authorization.fact.seat
        && binding.relatedTaskIds.every(task => authorization.fact.taskIds.includes(task))
      const busy = readWindowStatus(initial).busyReasons
      if ((!old || old.barrierReleased) && authorized && busy.every(reason => reason.kind === 'inbox')
        && await withdrawOrphanedOpening(this.ctx, this.state, request.sessionId)) {
        initial = await this.runtime.evidence(request.sessionId)
      }
    }
    const admitted = await this.state.mutate<T.EngineCloseData | T.CloseSeatResult>((effects) => {
      if (authorization) {
        const opened = effects.findLast(effect => (effect.kind === 'open/created' || effect.kind === 'open/configured')
          && effect.data.sessionId === request.sessionId)
        const binding = opened?.kind === 'open/created' || opened?.kind === 'open/configured' ? opened.data.binding : undefined
        if (binding?.kind !== 'seat' || binding.seat !== authorization.fact.seat
          || binding.relatedTaskIds.some(task => !authorization.fact.taskIds.includes(task))) {
          return { effects: [], result: rejected('unauthorized', 'Close attribution does not cover this window.', 'Refresh the entry authority.') }
        }
      }
      const old = closingState(effects, request.sessionId)
      if (old?.phase === 'closed') return { effects: [], result: old }
      if (authorization && old && !old.barrierReleased) return { effects: [], result:
        rejected('state-conflict', 'An admitted close requires local recovery.', 'Reconcile the original close before retrying.') }
      if (old && !old.barrierReleased) return { effects: [], result: old.operationId === request.operationId ? old
        : rejected('state-conflict', 'Another close owns this window.', 'Resume the original close.') }
      const busyReasons = readWindowStatus(initial).busyReasons
      if (initial.stateVersion !== request.expectedStateVersion) return { effects: [], result: { status: 'conflict',
        expectedStateVersion: request.expectedStateVersion, actualStateVersion: initial.stateVersion,
        ...(busyReasons.length ? { busyReasons } : {}) } }
      const cancelApproval = !report && initial.approvals.length > 0
        && busyReasons.every(reason => reason.kind === 'turn' || reason.kind === 'approval' || reason.kind === 'inbox')
      if (busyReasons.length && !cancelApproval) return { effects: [], result: { status: 'busy', sessionId: request.sessionId, busyReasons } }
      const current = latestReport(effects, request.sessionId)
      if (report && (current?.reportId !== report.reportId || current.stateVersion !== report.stateVersion || !current.canClose)) {
        return { effects: [], result: rejected('state-conflict', 'Close authorization changed.', 'Read the latest report.') }
      }
      const replacement = effects.findLast(effect => effect.kind === 'window/replacement'
        && (effect.data.oldSessionId === request.sessionId || effect.data.newSessionId === request.sessionId))
      const approvalDetail = cancelApproval || old?.phase === 'rechecking' && old.detail !== undefined
      const orphaned = effects.findLast(effect => effect.kind === 'open/opening-failed' && effect.data.sessionId === request.sessionId)
      const ownerLost = orphaned?.kind === 'open/opening-failed'
        && orphaned.data.failure?.cause?.domain === 'seat-local' && orphaned.data.failure.cause.code === 'opening-owner-lost'
      const reason: T.WindowEndReason = ownerLost ? 'owner-dead' : approvalDetail ? 'manual' : replacement?.kind === 'window/replacement'
        && replacement.data.phase !== 'completed' && replacement.data.phase !== 'failed'
        ? replacement.data.failure ? 'replacement-failed' : 'replaced' : report ? 'self-report' : 'manual'
      const data: T.EngineCloseData = { sessionId: request.sessionId, operationId: request.operationId,
        phase: 'admission', reason, ...(approvalDetail
          ? { detail: 'approval-pending-cancelled' as const } : {}),
        stateVersion: initial.stateVersion, endedAt: null,
        reportId: current?.reportId ?? null, selfReport: current,
        selfReportStatus: current ? 'submitted' : effects.some(effect => effect.kind === 'report/revoked'
          && effect.data.sessionId === request.sessionId) ? 'revoked' : 'not-submitted' }
      return { result: data, effects: [localFact({ kind: 'window/closing', operationId: request.operationId,
        sessionId: request.sessionId, data })] }
    }, authorization && transactions ? { transactions, grant: authorization, request } : undefined)
    if ('status' in admitted) return admitted
    if (admitted.phase === 'closed' && admitted.endedAt) return { status: 'closed', sessionId: request.sessionId,
      phase: 'closed', endedAt: admitted.endedAt, stateVersion: admitted.stateVersion }
    let closing = admitted
    const release = async () => {
      await this.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/closing',
        operationId: request.operationId, sessionId: request.sessionId,
        data: { ...closing, barrierReleased: true } })] }))
    }
    try {
      const revoked = await validate()
      if (revoked) { await release(); return revoked }
      if (admitted.detail === 'approval-pending-cancelled'
        && !this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(request.sessionId)) {
        const beforeCancel = await this.runtime.evidence(request.sessionId)
        const busyReasons = readWindowStatus(beforeCancel).busyReasons
        if (beforeCancel.stateVersion !== admitted.stateVersion) {
          await release()
          return { status: 'conflict', expectedStateVersion: admitted.stateVersion,
            actualStateVersion: beforeCancel.stateVersion, ...(busyReasons.length ? { busyReasons } : {}) }
        }
        if (beforeCancel.approvals.length) {
          if (busyReasons.some(reason => reason.kind !== 'turn' && reason.kind !== 'approval' && reason.kind !== 'inbox')) {
            await release()
            return { status: 'busy', sessionId: request.sessionId, busyReasons }
          }
          const controller = this.ctx.get('sessionController')
          const agent = this.ctx.get('agents')?.get(request.sessionId)
          if (!controller || !agent) {
            await release()
            return rejected('owner-unknown', 'Approval cancellation requires the current owner.', 'Restore the Session owner.')
          }
          controller.cancel({ sessionId: request.sessionId })
          await agent.whenIdle()
        }
        const settled = await this.runtime.evidence(request.sessionId)
        closing = { ...admitted, phase: 'rechecking', stateVersion: settled.stateVersion }
        const remaining = readWindowStatus(settled).busyReasons
        if (remaining.length) {
          await release()
          return { status: 'busy', sessionId: request.sessionId, busyReasons: remaining }
        }
        const revokedAfterCancel = await validate()
        if (revokedAfterCancel) { await release(); return revokedAfterCancel }
        await this.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/closing',
          operationId: request.operationId, sessionId: request.sessionId, data: closing })] }))
      }
      await createCloseExecutor(this.ctx, this.runtime, this.options).archive(request)
      const endedAt = new Date().toISOString()
      const closed: T.EngineCloseData = { ...closing, phase: 'closed', endedAt,
        stateVersion: closing.stateVersion + 1 }
      await engine.recordClosed(closed)
      return { status: 'closed', sessionId: request.sessionId, phase: 'closed',
        endedAt, stateVersion: closed.stateVersion }
    } catch (error) {
      if (!this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(request.sessionId)) {
        await this.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/closing',
          operationId: request.operationId, sessionId: request.sessionId,
          data: { ...closing, barrierReleased: true } })] }))
      }
      throw error
    }
  }
  /** Drain every accepted close before the provider disappears. */
  async drain(): Promise<void> { await Promise.allSettled(this.running.values()) }
}
