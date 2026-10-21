/** Serial reconciliation owns in-flight writes until acknowledgement; timeouts never cancel them. */
import { randomUUID } from 'node:crypto'
import type { LedgerEvent, LedgerEventId, LedgerLifecycle, LedgerNodeId, SessionLedger } from '@panedesk/dsh-session-ledger'
import { inspectProcessIdentity } from './process.ts'
import type { ProcessObservation } from './process.ts'

/** Public-service subset needed by the independent watcher. */
export type WatchLedger = Pick<SessionLedger, 'snapshot' | 'finishRun' | 'appendEvent'>
/** Per-run measurement separates death observation from durable acknowledgement. */
export interface RecoveryMeasurement {
  runId: string
  deathObservedAt: number
  persistedAt: number
  latencyMs: number
  outcome: 'appended' | 'existing'
}
/** A completed round exposes budget breaches even when alert persistence fails. */
export interface ReconcileReport {
  startedAt: number
  finishedAt: number
  elapsedMs: number
  inspected: number
  deferred: number
  recoveries: RecoveryMeasurement[]
  alerts: string[]
}
/** Runtime-owned clock and process seams; no model-authored inputs are accepted. */
export interface ReconcileOptions {
  nodeId: LedgerNodeId
  intervalMs: number
  settlementBudgetMs: number
  now?: () => number
  monotonic?: () => number
  inspect?: typeof inspectProcessIdentity
  onAlert?: (code: string) => void
}
function eventFor(run: LedgerLifecycle, observedAt: number): Pick<LedgerEvent, 'schemaVersion' | 'eventId' | 'nodeId' | 'observedAt' | 'runId' | 'sessionId'> {
  return { schemaVersion: 1, eventId: randomUUID() as LedgerEventId, nodeId: run.start.nodeId,
    observedAt, runId: run.start.runId, sessionId: run.start.sessionId }
}
/** Inspect local in-flight runs and settle confirmed deaths through the provider's atomic slot.
 * @param ledger - injected service; no journal or private-lock access is used.
 * @param options - local node, scheduling budgets, and optional runtime test seams.
 * @returns completed round measurements; write failures reject with no claimed acknowledgement.
 */
export async function reconcileRuns(ledger: WatchLedger, options: ReconcileOptions): Promise<ReconcileReport> {
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now())
  const inspect = options.inspect ?? inspectProcessIdentity
  const started = monotonic()
  const report: ReconcileReport = { startedAt: now(), finishedAt: 0, elapsedMs: 0, inspected: 0, deferred: 0, recoveries: [], alerts: [] }
  const source = await ledger.snapshot({ nodeId: options.nodeId })
  const runs = source.rows.filter((row): row is LedgerLifecycle => row.kind === 'run' && !row.finish && row.start.nodeId === options.nodeId)
  const alert = async (run: LedgerLifecycle, code: string, message: string) => {
    report.alerts.push(code)
    options.onAlert?.(code)
    const result = await ledger.appendEvent({ ...eventFor(run, now()), kind: 'alert', alert: { code, message, redacted: true } })
    if (result.kind === 'conflict') throw new Error('Watcher alert append conflict')
  }
  if (!source.complete) {
    if (runs[0]) await alert(runs[0], 'watch-incomplete-snapshot', 'Reconciliation refused an incomplete ledger snapshot')
    throw new Error('Watcher requires a complete ledger snapshot')
  }
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    if (!run) break
    if (monotonic() - started >= options.settlementBudgetMs) { report.deferred = runs.length - index; break }
    const identity = run.start.processIdentity
    if (!identity) continue
    const observation: ProcessObservation = await inspect(identity, options.nodeId)
    report.inspected++
    const observedAt = now(), observedTick = monotonic()
    if (observation.liveness === 'dead') {
      // finishRun owns the cross-process CAS; no observation write delays settlement.
      let pendingAlert: Promise<void> | undefined
      let alertFailure: unknown
      const deadline = setTimeout(() => {
        pendingAlert = alert(run, 'watch-write-still-pending', 'Terminal acknowledgement exceeded the scheduling budget; write remains in flight')
          .catch((error: unknown) => { alertFailure = error })
      }, Math.max(1, Math.min(10000, options.settlementBudgetMs - (monotonic() - started))))
      const result = await (async () => {
        try {
          return await ledger.finishRun({ runId: run.start.runId, observedAt, endReason: 'killed',
            upstreamStopReason: `process-${observation.reason}`, recovered: true,
            deliveryState: run.start.deliveryPaths.length ? 'uncheckable' : 'not-requested' })
        } finally { clearTimeout(deadline) }
      })()
      const persistedAt = now(), latencyMs = monotonic() - observedTick
      await pendingAlert
      if (alertFailure !== undefined) throw new Error('Pending-write alert could not be persisted', { cause: alertFailure })
      if (result.kind === 'conflict' || result.event.kind !== 'run/end') throw new Error('Watcher terminal slot was not acknowledged')
      report.recoveries.push({ runId: run.start.runId, deathObservedAt: observedAt, persistedAt, latencyMs, outcome: result.kind })
      // The acknowledgement time cannot be known inside the earlier terminal append.
      await alert(run, 'watch-recovery-timing', JSON.stringify({ deathObservedAt: observedAt, persistedAt, latencyMs, outcome: result.kind }))
      if (latencyMs > 10000 || persistedAt - observedAt > 10000) await alert(run, 'watch-recovery-late', 'Death-to-durable-acknowledgement latency exceeded 10000ms')
    }
    if (monotonic() - started < options.settlementBudgetMs) {
      const result = await ledger.appendEvent({ ...eventFor(run, observedAt), kind: 'process/observed',
        identity: { ...identity, verification: observation.verification }, liveness: observation.liveness })
      if (result.kind === 'conflict') throw new Error('Watcher observation append conflict')
    }
  }
  report.elapsedMs = monotonic() - started
  if (runs[0] && report.elapsedMs > options.intervalMs) await alert(runs[0], 'watch-round-target-exceeded', 'Reconciliation exceeded its polling target')
  if (runs[0] && (report.elapsedMs >= options.settlementBudgetMs || report.deferred > 0)) await alert(runs[0], 'watch-round-budget-exceeded', 'Reconciliation exhausted its scheduling budget; in-flight writes were not cancelled')
  report.finishedAt = now()
  report.elapsedMs = monotonic() - started
  return report
}

/** Owned polling lifecycle; teardown awaits the last round rather than abandoning writes. */
export interface WatchController {
  stop(): Promise<void>
  readonly settled: Promise<void>
}
/** Start non-overlapping polling with an immediate optional startup scan.
 * @param ledger - injected ledger service.
 * @param options - reconciliation policy plus round/error callbacks.
 * @returns owned controller; errors stop polling and reject settled after reporting.
 */
export function startWatching(ledger: WatchLedger, options: ReconcileOptions & {
  scanOnStart: boolean
  onRound?: (report: ReconcileReport) => void | Promise<void>
  onError: (error: unknown) => void
}): WatchController {
  const state = { stopped: false }
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
  const isStopped = () => state.stopped
  const wait = (ms: number) => new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, ms) })
  const settled = (async () => {
    if (!options.scanOnStart) await wait(options.intervalMs)
    while (!isStopped()) {
      const report = await reconcileRuns(ledger, options)
      await options.onRound?.(report)
      if (!isStopped()) await wait(Math.max(1, options.intervalMs - report.elapsedMs))
    }
  })()
  void settled.catch((error: unknown) => { state.stopped = true; options.onError(error) })
  return { settled, async stop() { state.stopped = true; if (timer) clearTimeout(timer); wake?.(); await settled } }
}
