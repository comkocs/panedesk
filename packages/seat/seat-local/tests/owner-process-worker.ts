/** Child-only engine host uses real journal evidence and parent-owned process identities. */
import { Context } from '@panedesk/cordis'
import { readFile } from 'node:fs/promises'
import { JournalSessionLedger, type LedgerRunId } from '@panedesk/dsh-session-ledger'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import type * as T from '@panedesk/dsh-seat'
import { createOpenExecutor } from '../src/executor.ts'
import { createLocalRuntime } from '../src/runtime.ts'
import type { LocalSeatOptions } from '../src/service-options.ts'
import { definition, seat } from './fixtures.ts'

const [home, pidText, mode = 'normal', phase = 'seed'] = process.argv.slice(2)
if (!home || !pidText) throw new Error('Missing isolated process arguments')
const ctx = new Context(), ledger = new JournalSessionLedger(ctx, { dshHome: home })
const nodeId = String(await ledger.nodeId()) as T.SeatNodeId
const sourceId = 'source-a' as T.SeatSourceId, second = 'seat-b' as T.SeatName
const def = definition(home, { autoKeepAlive: false, rules: [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
  trigger: { kind: 'external', sourceId }, timeWindows: [], exclusiveTags: ['resource-a'] }] })
const config: T.SeatEngineConfig = { nodeName: 'node-a', nodeAliases: { 'node-a': nodeId }, dedupWindowMs: 1000,
  maxDecisionBytes: 200000, maxSourceBytes: 20000, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
  callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
  ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000, nodeEngineWindowLimit: 1 }
const options: LocalSeatOptions = { directory: home, nodeId, nodeName: 'node-a', nodeAliases: config.nodeAliases,
  defaults: def, maxSourceBytes: 20000, maxPlans: 10, maxOpeningBytes: 20000, maxBatchSeats: 10,
  pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' }
const engine = new SeatEngine(ctx, { home, nodeId, config }, { ledger: () => ledger,
  seats: () => ({ resolve: async name => ({ ...def, seat: name }),
    list: async () => ({ status: 'listed', sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }),
    close: async () => { throw new Error('Unexpected close') } }) })
const local = createOpenExecutor(ctx, createLocalRuntime(ctx, options), options)
const physical = new Set<string>()
const executor: T.SeatOpenExecutor = { ...local,
  observe: async open => phase === 'recover' || physical.has(open.sessionId) ? 'matching' : 'absent', configure: async () => {},
  create: async (open) => {
    physical.add(open.sessionId)
    if (open.binding.kind === 'seat' && open.binding.seat === seat) {
      const pid = Number(pidText), stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const startIdentity = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]!
      await ledger.beginRun({ runId: `run-${open.sessionId}` as LedgerRunId, sessionId: open.sessionId,
        rootSessionId: open.sessionId, nodeId: await ledger.nodeId(), seat, window: 'window-a', identitySource: 'settings',
        accountLabel: 'unknown', startedAt: Date.now(), launchState: 'started', deliveryPaths: [],
        processIdentity: { nodeId: await ledger.nodeId(), pid, startIdentity, registeredAt: Date.now(),
          bootIdentity: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
          verification: mode === 'unknown' ? 'unverified' : 'verified' } })
    }
    return open.sessionId
  }, opening: async () => ({ messageId: 'opening-a' as never, state: 'completed' }) }
engine.registerExecutor(executor)
let finishCallback!: () => void
const callbackBarrier = new Promise<void>((resolve) => { finishCallback = resolve })
engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {
  if (mode === 'slow') { process.send?.({ kind: 'callback-started' }); await callbackBarrier }
} })
ctx.on('seat/decision', (decision) => {
  for (const effect of decision.effects) {
    if (effect.kind === 'resource/released') process.send?.({ kind: 'released', release: effect.data })
    if (effect.kind === 'open/configured' && effect.data.phase === 'active' && effect.data.binding.kind === 'seat'
      && effect.data.binding.seat === second) process.send?.({ kind: 'admitted' })
  }
})
await engine.ready()
process.send?.({ kind: 'ready', readyAt: (await engine.nodeStatus()).readyAt })
if (phase === 'seed') {
  await engine.setProjectMode({ projectId: def.projectId, mode: 'auto', expectedRevision: 0, operationId: 'mode-a' as T.SeatOperationId })
  const accept = (target: T.SeatName, id: string) => engine.accept({ triggerId: id as T.TriggerId, sourceId,
    eventId: id as T.SourceEventId, kind: 'external', evidence: { kind: 'external', eventType: id }, seat: target,
    projectId: def.projectId, receivedAt: new Date().toISOString(), dataDigest: 'digest-a' as T.SeatDigest, data: null, callbackRef: sourceId })
  await accept(seat, 'event-a'); await engine.drive()
  await accept(second, 'event-b'); await engine.drive()
  process.send?.({ kind: 'seeded', resources: engine.journal.projection.resources.size,
    pending: engine.journal.projection.pending.size })
}
process.on('message', (message: unknown) => {
  if (message === 'status') process.send?.({ kind: 'status', resources: engine.journal.projection.resources.size,
    pending: engine.journal.projection.pending.size })
  if (message === 'stop') {
    finishCallback()
    void engine.shutdown().then(() => ctx.fiber.dispose()).then(() => { process.disconnect?.() })
      .catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
  }
})
