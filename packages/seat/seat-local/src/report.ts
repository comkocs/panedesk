/** Self-report authorization never substitutes for live runtime evidence. */
import type { SessionId } from '@panedesk/dsh-session'
import type { CloseSeatResult, CloseSelfReport, SeatOperationId } from '@panedesk/dsh-seat'
import { readWindowStatus, type WindowEvidence } from './status.ts'

/** Engine capabilities keep report revision checks inside the actual close transaction. */
export interface ReportRuntime {
  latest(sessionId: SessionId): Promise<CloseSelfReport | null>
  evidence(sessionId: SessionId): Promise<WindowEvidence>
  remind(sessionId: SessionId, operationId: SeatOperationId, text: string, mode: 'steer'): Promise<void>
  closeIfCurrent(report: CloseSelfReport, stateVersion: number): Promise<CloseSeatResult>
}

/** Evaluate current reports after report, turn, child or job settlement events. */
export class CloseCoordinator {
  constructor(private readonly runtime: ReportRuntime) {}

  /** Auto-close only after all three conditions hold; the executor rechecks the report under its barrier.
   * @param sessionId - observed window.
   * @returns close result, or null when there is no current close authorization.
   */
  async evaluate(sessionId: SessionId): Promise<CloseSeatResult | null> {
    const report = await this.runtime.latest(sessionId)
    if (report === null || !report.canClose) return null
    const evidence = await this.runtime.evidence(sessionId)
    const { busyReasons } = readWindowStatus(evidence)
    if (busyReasons.length) {
      await this.runtime.remind(sessionId, `${report.reportId}:busy` as SeatOperationId,
        `This window still has pending work: ${busyReasons.map(item => item.summary).join('; ')}`, 'steer')
      return { status: 'busy', sessionId, busyReasons }
    }
    return this.runtime.closeIfCurrent(report, evidence.stateVersion)
  }
}
