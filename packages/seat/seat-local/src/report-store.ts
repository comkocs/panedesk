/** Reports are journal facts; revocation and replacement retain their state-version fences. */
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { LocalEngineState, localFact } from './engine-state.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Read the latest submitted report unless a later revocation invalidated it.
 * @param effects - committed journal order.
 * @param sessionId - report owner.
 * @returns latest unrevoked report, or null.
 */
export function latestReport(effects: readonly T.EngineEffect[], sessionId: SessionId): T.CloseSelfReport | null {
  let report: T.CloseSelfReport | null = null
  for (const effect of effects) {
    if (effect.kind === 'report/submitted' && effect.data.report.sessionId === sessionId) report = effect.data.report
    if ((effect.kind === 'report/revoked' || effect.kind === 'window/closed') && effect.data.sessionId === sessionId) report = null
  }
  return report
}

/** Report writes commit before automatic-close evaluation. */
export class ReportStore {
  constructor(private readonly state: LocalEngineState) {}

  /** Persist a report without interpreting its claims as observed runtime facts.
   * @param request - validated report and trusted attribution.
   * @param authority - authenticated actor.
   * @returns durable revision, replay or refusal.
   */
  submit(request: T.SubmitCloseReportRequest, authority: T.SeatCallContext): Promise<T.CloseReportResult> {
    return this.state.mutate<T.CloseReportResult>((effects) => {
      const prior = effects.find(effect => effect.operationId === request.operationId)
      if (prior !== undefined) return { effects: [], result: prior.kind === 'report/submitted'
        && digest(prior.data.report) === digest(request.report)
        ? { status: 'recorded', reportId: prior.data.report.reportId, stateVersion: prior.data.report.stateVersion }
        : rejected('operation-id-conflict', 'The report operation has different contents.', 'Use its original request.') }
      if (effects.some(effect => (effect.kind === 'window/closing' || effect.kind === 'window/closed')
        && effect.data.sessionId === request.report.sessionId)) return { effects: [],
        result: rejected('state-conflict', 'Closing already owns this window.', 'Inspect the committed close operation.') }
      const versions = effects.flatMap(effect => effect.kind === 'report/submitted' && effect.data.report.sessionId === request.report.sessionId
        ? [effect.data.report.stateVersion] : effect.kind === 'report/revoked' && effect.data.sessionId === request.report.sessionId
          ? [effect.data.stateVersion] : [])
      if (request.report.stateVersion <= Math.max(0, ...versions)) return { effects: [],
        result: rejected('state-conflict', 'A newer report revision exists.', 'Read the latest report before submitting.') }
      return { result: { status: 'recorded', reportId: request.report.reportId, stateVersion: request.report.stateVersion }, effects: [localFact({
        kind: 'report/submitted', sessionId: request.report.sessionId, operationId: request.operationId,
        data: { report: structuredClone(request.report), principalId: authority.principalId,
          ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
          ...(request.rootCallId === undefined ? {} : { rootCallId: request.rootCallId }) },
      })] }
    })
  }

  /** Revoke only the currently observed report; replay returns the same committed revision.
   * @param request - exact report and observed revision.
   * @param authority - authenticated actor.
   * @returns durable revocation or CAS refusal.
   */
  revoke(request: T.RevokeCloseReportRequest, authority: T.SeatCallContext): Promise<T.CloseReportResult> {
    return this.state.mutate<T.CloseReportResult>((effects) => {
      const prior = effects.find(effect => effect.operationId === request.operationId)
      if (prior !== undefined) return { effects: [], result: prior.kind === 'report/revoked'
        && prior.data.reportId === request.reportId && prior.data.sessionId === request.sessionId
        && prior.data.stateVersion === request.expectedStateVersion + 1
        ? { status: 'revoked', reportId: request.reportId, stateVersion: prior.data.stateVersion }
        : rejected('operation-id-conflict', 'The revocation operation has different contents.', 'Use its original request.') }
      if (effects.some(effect => (effect.kind === 'window/closing' || effect.kind === 'window/closed')
        && effect.data.sessionId === request.sessionId)) return { effects: [],
        result: rejected('state-conflict', 'Closing already owns this window.', 'Inspect the committed close operation.') }
      const current = latestReport(effects, request.sessionId)
      if (current?.reportId !== request.reportId || current.stateVersion !== request.expectedStateVersion) return { effects: [],
        result: rejected('state-conflict', 'The current report changed.', 'Read the report before revoking it.') }
      const stateVersion = current.stateVersion + 1
      return { result: { status: 'revoked', reportId: request.reportId, stateVersion }, effects: [localFact({
        kind: 'report/revoked', sessionId: request.sessionId, operationId: request.operationId,
        data: { reportId: request.reportId, sessionId: request.sessionId, stateVersion, principalId: authority.principalId },
      })] }
    })
  }
}
