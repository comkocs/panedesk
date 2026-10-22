import { randomUUID } from 'node:crypto'
import { brandString } from '@panedesk/dsh-brand'
import type { TokenUsage } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@panedesk/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@panedesk/dsh-subprocess'
import type { LedgerAppendResult, LedgerEndReason, LedgerEventId, LedgerRunId, LedgerSessionContext, SessionLedger } from '@panedesk/dsh-session-ledger'

/** Optional, trusted accounting seam; external definitions are never enforced here. */
export interface ExternalLedgerSpec {
  readonly ledger?: Pick<SessionLedger, 'beginRun' | 'finishRun' | 'appendEvent'>
  readonly parentContext?: LedgerSessionContext
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly observeUsage?: (usage: TokenUsage) => void
  readonly observeReportedUsage?: (usage: Readonly<Record<string, number>>) => void
}

/** Record lifecycle facts without creating duplicate billable calls.
 * @param request - trusted parent request and cancellation signal.
 * @param spec - optional ledger and existing process launcher.
 * @param start - unchanged backend startup transaction.
 * @returns the backend handle with accounting included in disposal acknowledgement.
 */
export async function recordExternalRun<S extends ExternalLedgerSpec>(
  request: Pick<SubagentStartRequest, 'signal'>,
  spec: S,
  start: (spec: S) => Promise<SubagentRun>,
): Promise<SubagentRun> {
  const ledger = spec.ledger
  if (ledger === undefined) return start(spec)
  const parent = spec.parentContext
  if (parent === undefined) throw new Error('External ledger requires trusted parent context')
  const id = brandString<SessionId>(randomUUID())
  const runId = brandString<LedgerRunId>(id)
  const committed = (result: LedgerAppendResult): void => {
    if (result.kind === 'conflict') throw new Error('External lifecycle ledger conflict')
  }
  committed(await ledger.beginRun({
    ...parent, runId, parentRunId: parent.runId, sessionId: id,
    parentSessionId: parent.sessionId, identitySource: 'inherited',
    subagentRunId: brandString<NonNullable<LedgerSessionContext['subagentRunId']>>(id),
    startedAt: Date.now(), launchState: 'pending', deliveryPaths: [],
  }))
  let usage: TokenUsage | undefined
  let reportedUsage: Readonly<Record<string, number>> | undefined
  let reportedIdentity = false
  let terminal: LedgerEndReason | undefined
  let upstreamStopReason: string | undefined
  let cancelled = request.signal.aborted
  const onAbort = (): void => { cancelled = true }
  request.signal.addEventListener('abort', onAbort, { once: true })
  let observation = Promise.resolve()
  let finishTask: Promise<void> | undefined
  const finish = (outcome?: SubprocessOutcome): Promise<void> => {
    finishTask ??= (async () => {
      await observation
      committed(await ledger.finishRun({
        runId, endedAt: Date.now(), observedAt: Date.now(),
        endReason: terminal ?? (cancelled ? 'cancelled' : outcome?.signal ? 'killed' : 'error'),
        ...upstreamStopReason === undefined ? {} : { upstreamStopReason },
        ...outcome?.exitCode == null ? {} : { exitCode: outcome.exitCode },
        ...outcome?.signal == null ? {} : { signal: outcome.signal },
        recovered: false, deliveryState: 'not-requested',
        externalBackend: {
          definitionEnforcement: 'not-applicable',
          ...usage === undefined ? {} : { usage },
          ...reportedUsage === undefined ? {} : { reportedUsage },
          usageState: usage === undefined && reportedUsage === undefined ? 'missing' : 'partial',
          processIdentityState: reportedIdentity ? 'reported' : 'not-reported',
        },
      }))
    })()
    return finishTask
  }
  const observedSpec: S = {
    ...spec,
    observeUsage: (value: TokenUsage) => { usage = value; spec.observeUsage?.(value) },
    observeReportedUsage: (value: Readonly<Record<string, number>>) => { reportedUsage = value; spec.observeReportedUsage?.(value) },
    spawn: (spawnSpec: SubprocessSpawnSpec) => {
      const child = spec.spawn(spawnSpec)
      const identity = child.processIdentity
      if (identity !== undefined) {
        reportedIdentity = true
        observation = observation.then(async () => {
          const verified = identity.startIdentity !== undefined && identity.bootIdentity !== undefined
          committed(await ledger.appendEvent({
            schemaVersion: 1, eventId: brandString<LedgerEventId>(randomUUID()),
            nodeId: parent.nodeId, observedAt: Date.now(), runId, sessionId: id,
            kind: 'process/observed', liveness: verified ? 'confirmed' : 'unknown',
            identity: { ...identity, nodeId: parent.nodeId, registeredAt: Date.now(), verification: verified ? 'verified' : 'unverified' },
          }))
        })
        void observation.catch(() => {})
      }
      void child.done.then(outcome => finish(outcome), () => finish()).catch(() => {})
      return child
    },
  }
  try {
    request.signal.throwIfAborted()
    const run = await start(observedSpec)
    const result = run.result.then((value) => {
      upstreamStopReason = value.stopReason
      terminal = value.stopReason === 'completed' ? 'completed'
        : value.stopReason === 'aborted' ? 'cancelled' : 'error'
      return value
    })
    let disposal: Promise<void> | undefined
    return {
      id, result,
      dispose: () => (disposal ??= (async () => {
        cancelled = true
        try { await run.dispose() } finally {
          request.signal.removeEventListener('abort', onAbort)
          await finish()
        }
      })()),
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    await finish()
    throw error
  }
}
