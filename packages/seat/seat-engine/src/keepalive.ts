/** Idle maintenance is derived from cache refresh evidence, never user activity. */
import type { SessionId } from '@panedesk/dsh-session'
import type { CacheRemaining, CacheRenewResult } from '@panedesk/dsh-llm-cache'
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, digest } from './journal.ts'
import { fact } from './triggers.ts'

/** Runtime evidence remains optional; absence forbids speculative maintenance. */
export interface KeepAliveRuntime {
  remaining(sessionId: SessionId): Promise<CacheRemaining>
  renew(sessionId: SessionId, operationId: T.SeatOperationId): Promise<CacheRenewResult>
}
/** One owned schedule per window is recomputed from evidence on host recovery. */
export class KeepAliveScheduler {
  private readonly schedules = new Map<SessionId, { evidenceAt: number; dueAt: number }>()
  constructor(private readonly journal: EngineJournal, private readonly seats: () => Pick<T.SeatService, 'resolve' | 'list'> | undefined,
    private readonly runtime: KeepAliveRuntime, private readonly stopped: (sessionId: SessionId) => Promise<boolean>) {}

  /** Reconcile idle windows; expired recovery points are recorded but never replayed.
   * @param now - current host clock in milliseconds.
   */
  async drive(now = Date.now()): Promise<void> {
    for (const open of this.journal.projection.opens.values()) {
      if (open.binding.kind !== 'seat' || !this.journal.projection.resources.has(open.sessionId)) {
        this.schedules.delete(open.sessionId); continue
      }
      const seats = this.seats(), definition = await seats?.resolve(open.binding.seat)
      if (!definition || 'status' in definition) { await this.skip(open.sessionId, 'evidence-unavailable', null, null); continue }
      if (definition.autoKeepAlive === false) { this.schedules.delete(open.sessionId); continue }
      if (open.phase !== 'active' || await this.stopped(open.sessionId)) { this.schedules.delete(open.sessionId); continue }
      const page = await seats?.list({})
      const window = page?.status === 'listed' ? page.sessions.find(item => item.sessionId === open.sessionId) : undefined
      if (!window || window.evidence !== 'complete') { await this.skip(open.sessionId, 'evidence-unavailable', null, null); continue }
      if (window.engineStatus === 'closing' || window.engineStatus === 'budget-stopped' || (window.status !== 'idle' && window.status !== 'completed')
        || window.runningSubagents > 0 || window.activeJobs > 0 || window.busyReasons.length > 0) {
        this.schedules.delete(open.sessionId); continue
      }
      const evidence = await this.runtime.remaining(open.sessionId)
      if (evidence.kind !== 'estimated' || !Number.isFinite(evidence.evidenceAt) || evidence.evidenceAt > now
        || !Number.isFinite(evidence.ttlSeconds) || evidence.ttlSeconds <= 0) {
        this.schedules.delete(open.sessionId)
        await this.skip(open.sessionId, 'evidence-unavailable', null, null); continue
      }
      const dueAt = evidence.evidenceAt + Math.max(0, evidence.ttlSeconds * 1000 - 240000)
      const schedule = this.schedules.get(open.sessionId)
      if (!schedule || schedule.evidenceAt !== evidence.evidenceAt) {
        this.schedules.set(open.sessionId, { evidenceAt: evidence.evidenceAt, dueAt })
        if (dueAt < now) {
          await this.skip(open.sessionId, evidence.ttlSeconds < 1800 ? 'ttl-too-short' : 'missed-due', evidence.evidenceAt, dueAt)
          continue
        }
      }
      if (now < dueAt) continue
      const operationId = digest([open.sessionId, evidence.evidenceAt, 'auto']) as string as T.SeatOperationId
      if (this.journal.projection.renewals.has(JSON.stringify([open.sessionId, operationId]))) continue
      if (evidence.ttlSeconds < 1800) { await this.skip(open.sessionId, 'ttl-too-short', evidence.evidenceAt, dueAt); continue }
      await this.renew(open.sessionId, operationId, 'auto', evidence.evidenceAt, dueAt, now)
    }
  }
  /** Reserve one maintenance attempt durably before calling the cache provider.
   * @param sessionId - retained window identity.
   * @param operationId - stable operation identity, shared across retries.
   * @param source - automatic scheduling or explicit user request.
   * @param evidenceAt - last observed cache refresh, or unavailable.
   * @param dueAt - automatic deadline, absent for manual requests.
   * @param now - observation clock.
   * @returns terminal evidence; an interrupted attempt is uncertain and never replayed.
   */
  async renew(sessionId: SessionId, operationId: T.SeatOperationId, source: 'auto' | 'manual',
    evidenceAt: number | null, dueAt: number | null, now = Date.now()): Promise<T.EngineKeepAliveData> {
    const key = JSON.stringify([sessionId, operationId])
    let previous: T.EngineKeepAliveData | undefined
    const attempt: T.EngineKeepAliveData = { sessionId, operationId, source, phase: 'attempted', reason: null,
      evidenceAt, dueAt, observedAt: new Date(now).toISOString() }
    await this.journal.commit((view) => {
      previous = view.renewals.get(key)
      return previous ? [] : [fact({ kind: 'cache/keepalive', sessionId, data: attempt })]
    })
    if (previous) return previous.phase === 'attempted' ? { ...previous, phase: 'uncertain', reason: 'prior-attempt' } : previous
    let result: CacheRenewResult
    try { result = await this.runtime.renew(sessionId, operationId) }
    catch { result = { kind: 'uncertain', reason: 'maintenance-unconfirmed' } }
    const settled: T.EngineKeepAliveData = { ...attempt, phase: result.kind === 'rejected' ? 'skipped' : result.kind,
      reason: result.kind === 'renewed' ? null : result.reason,
      evidenceAt: result.kind === 'renewed' ? result.evidenceAt : evidenceAt }
    await this.journal.commit(() => [fact({ kind: result.kind === 'rejected' ? 'cache/keepalive-skipped' : 'cache/keepalive',
      sessionId, data: settled })])
    return settled
  }
  private async skip(sessionId: SessionId, reason: string, evidenceAt: number | null, dueAt: number | null): Promise<void> {
    const operationId = digest([sessionId, evidenceAt, reason === 'evidence-unavailable' ? reason : 'auto']) as string as T.SeatOperationId
    await this.journal.commit(view => view.renewals.has(JSON.stringify([sessionId, operationId])) ? [] : [fact({
      kind: 'cache/keepalive-skipped', sessionId, data: { sessionId, operationId, source: 'auto', phase: 'skipped',
        reason, evidenceAt, dueAt, observedAt: new Date().toISOString() },
    })])
  }
}
