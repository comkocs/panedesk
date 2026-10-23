/** Local close barriers retain archive recovery and publish only flushed terminal facts. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { LocalEngineState, localFact } from './engine-state.ts'
import { latestReport } from './report-store.ts'
import { createCloseExecutor } from './close-executor.ts'
import { readWindowStatus } from './status.ts'
import { rejected } from './errors.ts'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'

/** Last committed close state, including a released pre-archive barrier. */
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
   * @returns flushed close, busy evidence or version conflict.
   */
  close(request: T.CloseSeatRequest, report?: T.CloseSelfReport): Promise<T.CloseSeatResult> {
    const previous = this.running.get(request.sessionId)
    if (previous) return previous.then(() => this.close(request, report))
    const work = this.run(request, report).finally(() => { this.running.delete(request.sessionId) })
    this.running.set(request.sessionId, work)
    return work
  }
  private async run(request: T.CloseSeatRequest, report?: T.CloseSelfReport): Promise<T.CloseSeatResult> {
    const engine = this.ctx.get('seatEngine')
    if (!engine) return rejected('unavailable', 'Close accounting is unavailable.', 'Restore the engine.')
    const initial = await this.runtime.evidence(request.sessionId)
    const admitted = await this.state.mutate<T.EngineCloseData | T.CloseSeatResult>((effects) => {
      const old = closingState(effects, request.sessionId)
      if (old?.phase === 'closed') return { effects: [], result: old }
      if (old && !old.barrierReleased) return { effects: [], result: old.operationId === request.operationId ? old
        : rejected('state-conflict', 'Another close owns this window.', 'Resume the original close.') }
      if (initial.stateVersion !== request.expectedStateVersion) return { effects: [], result: { status: 'conflict',
        expectedStateVersion: request.expectedStateVersion, actualStateVersion: initial.stateVersion } }
      const busyReasons = readWindowStatus(initial).busyReasons
      if (busyReasons.length) return { effects: [], result: { status: 'busy', sessionId: request.sessionId, busyReasons } }
      const current = latestReport(effects, request.sessionId)
      if (report && (current?.reportId !== report.reportId || current.stateVersion !== report.stateVersion || !current.canClose)) {
        return { effects: [], result: rejected('state-conflict', 'Close authorization changed.', 'Read the latest report.') }
      }
      const replacement = effects.findLast(effect => effect.kind === 'window/replacement'
        && (effect.data.oldSessionId === request.sessionId || effect.data.newSessionId === request.sessionId)
        && effect.data.phase !== 'completed' && effect.data.phase !== 'failed')
      const reason: T.WindowEndReason = replacement?.kind === 'window/replacement'
        ? replacement.data.failure ? 'replacement-failed' : 'replaced' : report ? 'self-report' : 'manual'
      const data: T.EngineCloseData = { sessionId: request.sessionId, operationId: request.operationId,
        phase: 'admission', reason, stateVersion: initial.stateVersion, endedAt: null,
        reportId: current?.reportId ?? null, selfReport: current,
        selfReportStatus: current ? 'submitted' : effects.some(effect => effect.kind === 'report/revoked'
          && effect.data.sessionId === request.sessionId) ? 'revoked' : 'not-submitted' }
      return { result: data, effects: [localFact({ kind: 'window/closing', operationId: request.operationId,
        sessionId: request.sessionId, data })] }
    })
    if ('status' in admitted) return admitted
    if (admitted.phase === 'closed' && admitted.endedAt) return { status: 'closed', sessionId: request.sessionId,
      phase: 'closed', endedAt: admitted.endedAt, stateVersion: admitted.stateVersion }
    try {
      await createCloseExecutor(this.ctx, this.runtime, this.options).archive(request)
      const endedAt = new Date().toISOString()
      const closed: T.EngineCloseData = { ...admitted, phase: 'closed', endedAt,
        stateVersion: admitted.stateVersion + 1 }
      await engine.recordClosed(closed)
      return { status: 'closed', sessionId: request.sessionId, phase: 'closed',
        endedAt, stateVersion: closed.stateVersion }
    } catch (error) {
      if (!this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(request.sessionId)) {
        await this.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/closing',
          operationId: request.operationId, sessionId: request.sessionId,
          data: { ...admitted, barrierReleased: true } })] }))
      }
      throw error
    }
  }
  /** Drain every accepted close before the provider disappears. */
  async drain(): Promise<void> { await Promise.allSettled(this.running.values()) }
}
