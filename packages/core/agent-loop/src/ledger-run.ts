/** Optional durable accounting for a top-level Agent residency. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { foldConsumedWork } from '@panedesk/dsh-agent'
import { brandString } from '@panedesk/dsh-brand'
import type { SessionEvent, SessionId } from '@panedesk/dsh-session'
import type { LedgerAppendResult, LedgerEventId, LedgerRunId, LedgerSessionContext } from '@panedesk/dsh-session-ledger'
import { readProcessIdentity } from '@panedesk/dsh-subprocess'
import { resolveLedgerIdentity, type LedgerIdentityOptions } from './ledger-identity.ts'

/** Admit one residency before registry publication; absence preserves the uninstrumented path.
 * @param ctx - factory-owned context retaining the optional service through teardown.
 * @param sessionId - exact local session identity.
 * @param settings - profile-owned default labels below launch-time sources.
 * @returns terminal writer retaining its attribution until acknowledgement, or undefined without a ledger.
 */
export async function beginAgentRun(
  ctx: Context,
  sessionId: SessionId,
  settings?: LedgerIdentityOptions,
): Promise<((events: readonly SessionEvent[], failed: boolean) => Promise<void>) | undefined> {
  const ledger = ctx.get('sessionLedger')
  if (ledger === undefined) return undefined
  const bound = ledger.contextFor(sessionId)
  if (bound?.subagentRunId !== undefined) {
    const snapshot = await ledger.snapshot({ sessionId })
    if (snapshot.rows.some(row => row.kind === 'run' && row.start.runId === bound.runId && !row.finish)) return undefined
  }
  const context: LedgerSessionContext = bound?.subagentRunId !== undefined ? {
    ...bound, runId: brandString<LedgerRunId>(randomUUID()), parentRunId: bound.runId,
  } : bound ?? {
    sessionId, rootSessionId: sessionId, runId: brandString<LedgerRunId>(randomUUID()),
    nodeId: await ledger.nodeId(), ...resolveLedgerIdentity(ctx, settings), accountLabel: 'unknown',
  }
  const observed = readProcessIdentity(process.pid)
  const processIdentity = { ...observed, nodeId: context.nodeId, registeredAt: Date.now(),
    verification: observed.startIdentity !== undefined && observed.bootIdentity !== undefined ? 'verified' as const : 'unverified' as const }
  assertWrite(await ledger.beginRun({ ...context, startedAt: Date.now(), launchState: 'started', deliveryPaths: [], processIdentity }))
  const unbind = ledger.bindContext(context)
  try {
    assertWrite(await ledger.appendEvent({ schemaVersion: 1, eventId: brandString<LedgerEventId>(randomUUID()),
      nodeId: context.nodeId, observedAt: Date.now(), runId: context.runId, sessionId, kind: 'process/observed',
      identity: processIdentity, liveness: processIdentity.verification === 'verified' ? 'confirmed' : 'unknown' }))
  } catch (error) {
    try {
      assertWrite(await ledger.finishRun({ runId: context.runId, observedAt: Date.now(), endReason: 'error',
        upstreamStopReason: 'process-observation-failed', recovered: false, deliveryState: 'not-requested' }))
    } finally { unbind() }
    throw error
  }
  return async (events, failed) => {
    const { end, droppedUnrun } = foldConsumedWork(events)
    const reason = end?.data.reason
    const timeout = reason?.kind === 'error' && reason.error.code === 'TIMEOUT'
    const endReason = failed ? 'error' : timeout ? 'timeout' : reason?.kind === 'error' ? 'error'
      : reason?.kind === 'aborted' || reason?.kind === 'interrupted' || droppedUnrun ? 'cancelled'
        : reason === undefined || reason.kind === 'completed' ? 'completed' : 'error'
    try {
      assertWrite(await ledger.finishRun({ runId: context.runId, endedAt: Date.now(), observedAt: Date.now(), endReason,
        upstreamStopReason: reason?.kind === 'aborted' && reason.reason.kind === 'interjection' ? 'interjection'
          : reason?.kind === 'error' ? `${reason.error.code}: ${reason.error.message}` : reason?.kind ?? 'idle',
        recovered: false, deliveryState: 'not-requested' }))
    } finally { unbind() }
  }
}

function assertWrite(result: LedgerAppendResult): void {
  if (result.kind === 'conflict') throw new Error('Agent lifecycle ledger append conflicted')
}
