/** Closing preserves upstream activity checks and publishes completion only after durable flush. */
import type { SessionId } from '@panedesk/dsh-session'
import type { CloseSeatRequest, CloseSeatResult, CloseSelfReport, SeatOperationId, WindowEndReason } from '@panedesk/dsh-seat'
import { readWindowStatus, type WindowEvidence } from './status.ts'

/** The engine owns persisted stages and the barrier; upstream providers own archive and titles. */
export interface CloseRuntime {
  evidence(sessionId: SessionId): Promise<WindowEvidence>
  begin(request: CloseSeatRequest, reason: WindowEndReason): Promise<CloseSeatResult | null>
  archiveSession(sessionId: SessionId): Promise<void>
  title(sessionId: SessionId): Promise<string>
  rename(sessionId: SessionId, title: string): Promise<void>
  flush(sessionId: SessionId): Promise<void>
  report(sessionId: SessionId): Promise<CloseSelfReport | null>
  finish(request: CloseSeatRequest, reason: WindowEndReason, report: CloseSelfReport | null): Promise<Extract<CloseSeatResult, { status: 'closed' }>>
  releaseBarrier(operationId: SeatOperationId): Promise<void>
}

/** Archive before adding the suffix, never force-stop a busy window.
 * @param runtime - engine transaction and upstream capabilities.
 * @param request - caller's observed state and stable operation identity.
 * @param suffix - locale-owned closed-window suffix.
 * @param reason - trusted operation reason.
 * @returns committed close or busy/CAS outcome.
 */
export async function closeWindow(runtime: CloseRuntime, request: CloseSeatRequest, suffix: string,
  reason: WindowEndReason = 'manual'): Promise<CloseSeatResult> {
  const initial = await runtime.evidence(request.sessionId)
  if (initial.stateVersion !== request.expectedStateVersion) return { status: 'conflict',
    expectedStateVersion: request.expectedStateVersion, actualStateVersion: initial.stateVersion }
  const initialBusy = readWindowStatus(initial).busyReasons
  if (initialBusy.length) return { status: 'busy', sessionId: request.sessionId, busyReasons: initialBusy }
  const existing = await runtime.begin(request, reason)
  if (existing !== null) return existing
  // An archive that succeeded must retain its barrier until recovery finishes the title and callback.
  let archived = false
  try {
    const current = await runtime.evidence(request.sessionId)
    const busyReasons = readWindowStatus(current).busyReasons
    if (busyReasons.length) return { status: 'busy', sessionId: request.sessionId, busyReasons }
    await runtime.archiveSession(request.sessionId)
    archived = true
    const title = await runtime.title(request.sessionId)
    if (!title.endsWith(suffix)) await runtime.rename(request.sessionId, `${title}${suffix}`)
    await runtime.flush(request.sessionId)
    const result = await runtime.finish(request, reason, await runtime.report(request.sessionId))
    await runtime.releaseBarrier(request.operationId)
    return result
  } finally {
    if (!archived) await runtime.releaseBarrier(request.operationId)
  }
}
