import { Context } from '@panedesk/cordis'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { LedgerAppendResult, LedgerEvent, LedgerLifecycle, LedgerRunFinish, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { SessionLedger } from '@panedesk/dsh-session-ledger'
import { reconcileRuns, startWatching } from '../src/watch.ts'
import { apply } from '../src/index.ts'
import { inspectProcessIdentity } from '../src/process.ts'

function run(id = 'run-a'): LedgerLifecycle {
  return { kind: 'run', liveness: 'unknown', start: { runId: id as LedgerLifecycle['start']['runId'], sessionId: id as LedgerLifecycle['start']['sessionId'],
    rootSessionId: id as LedgerLifecycle['start']['rootSessionId'], nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'], seat: 'seat-a', window: 'window-a',
    accountLabel: 'unknown', identitySource: 'startup', startedAt: 100, launchState: 'started', deliveryPaths: [],
    processIdentity: { nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'], pid: 123, startIdentity: '456', bootIdentity: 'boot-a', registeredAt: 100, verification: 'verified' } } }
}
class MemoryLedger extends SessionLedger {
  override resolveCallContext: SessionLedger['resolveCallContext'] = () => { throw new Error('Unused fixture operation') }
  override bindContext: SessionLedger['bindContext'] = () => { throw new Error('Unused fixture operation') }
  override contextFor: SessionLedger['contextFor'] = () => undefined
  override nodeId: SessionLedger['nodeId'] = () => { throw new Error('Unused fixture operation') }
  override importNode: SessionLedger['importNode'] = () => { throw new Error('Unused fixture operation') }
  events: LedgerEvent[] = []
  beforeFinish?: () => void | Promise<void>
  complete = true
  constructor(ctx: Context, readonly runs: LedgerLifecycle[]) { super(ctx) }
  override async snapshot(): Promise<LedgerSnapshot> { return { asOf: Date.now(), complete: this.complete, watermarks: {}, rows: [...this.runs, ...this.events.map(event => ({ kind: 'event' as const, event }))] } }
  override async query() { return this.snapshot() }
  override async finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult> {
    await this.beforeFinish?.()
    const row = this.runs.find(row => row.start.runId === input.runId)!
    const existed = row.finish !== undefined
    row.finish ??= input
    return { kind: existed ? 'existing' : 'appended', watermark: 'watermark-a' as LedgerSnapshot['watermarks'][string], event: {
      schemaVersion: 1, eventId: `end-${input.runId}` as LedgerEvent['eventId'], nodeId: row.start.nodeId, observedAt: row.finish.observedAt,
      runId: input.runId, sessionId: row.start.sessionId, kind: 'run/end', data: row.finish } }
  }
  override async appendEvent(event: LedgerEvent): Promise<LedgerAppendResult> {
    this.events.push(event)
    return { kind: 'appended', event, watermark: 'watermark-a' as LedgerSnapshot['watermarks'][string] }
  }
  override beginCall(): never { throw new Error('Unused fixture operation') }
  override finishCall(): never { throw new Error('Unused fixture operation') }
  override beginRun(): never { throw new Error('Unused fixture operation') }
  override appendArtifact(): never { throw new Error('Unused fixture operation') }
  override finishArtifact(): never { throw new Error('Unused fixture operation') }
  override registerWaitTool(): never { throw new Error('Unused fixture operation') }
  override priceUsage(): never { throw new Error('Unused fixture operation') }
}
const dead = async () => ({ liveness: 'dead' as const, verification: 'verified' as const, reason: 'missing' as const })
const policy = { nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'], intervalMs: 2000, settlementBudgetMs: 10000 }

describe('ledger death reconciliation', () => {
  it('recovers local dead runs and never overwrites a racing normal terminal slot', async () => {
    const a = run(), b = run('run-b'), remote = run('remote'); remote.start.nodeId = 'node-b' as typeof remote.start.nodeId
    const ledger = new MemoryLedger(new Context(), [a, b, remote])
    ledger.beforeFinish = () => { if (!b.finish) b.finish = { runId: b.start.runId, observedAt: 101, endReason: 'completed', recovered: false, deliveryState: 'not-requested' } }
    const report = await reconcileRuns(ledger, { ...policy, inspect: dead })
    expect(a.finish).toMatchObject({ endReason: 'killed', recovered: true })
    expect(a.finish!.endedAt).toBeUndefined()
    expect(b.finish).toMatchObject({ endReason: 'completed', recovered: false })
    expect(remote.finish).toBeUndefined()
    expect(report.recoveries.map(item => item.outcome)).toEqual(['appended', 'existing'])
    await reconcileRuns(ledger, { ...policy, inspect: dead })
    expect(ledger.events.filter(event => event.kind === 'alert' && event.alert.code === 'watch-recovery-timing')).toHaveLength(2)
  })
  it('measures delayed acknowledgement with a controlled clock, alerts, and defers new work', async () => {
    let time = 1000
    const ledger = new MemoryLedger(new Context(), [run(), run('run-b')])
    ledger.beforeFinish = () => { time += 10001 }
    const report = await reconcileRuns(ledger, { ...policy, now: () => time, monotonic: () => time, inspect: dead })
    expect(report.recoveries[0]).toMatchObject({ deathObservedAt: 1000, persistedAt: 11001, latencyMs: 10001 })
    expect(report.alerts).toEqual(expect.arrayContaining(['watch-recovery-late', 'watch-round-target-exceeded', 'watch-round-budget-exceeded']))
    expect(report.deferred).toBe(1)
    expect(ledger.runs[1]!.finish).toBeUndefined()
    process.stderr.write(JSON.stringify({ fixture: 'controlled-late-write', report }) + '\n')
  })
  it('alerts while a write is still pending and awaits its later acknowledgement', async () => {
    vi.useFakeTimers()
    const ledger = new MemoryLedger(new Context(), [run()])
    let release!: () => void
    ledger.beforeFinish = () => new Promise<void>((resolve) => { release = resolve })
    const onAlert = vi.fn()
    try {
      const pending = reconcileRuns(ledger, { ...policy, inspect: dead, onAlert })
      await vi.advanceTimersByTimeAsync(10001)
      expect(onAlert).toHaveBeenCalledWith('watch-write-still-pending')
      expect(ledger.runs[0]!.finish).toBeUndefined()
      release()
      const report = await pending
      expect(report.recoveries).toHaveLength(1)
      expect(ledger.runs[0]!.finish?.recovered).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('does not recover unknown identities and refuses incomplete snapshots', async () => {
    const ledger = new MemoryLedger(new Context(), [run()])
    await reconcileRuns(ledger, { ...policy, inspect: async () => ({ liveness: 'unknown', verification: 'unverified', reason: 'unreadable' }) })
    expect(ledger.runs[0]!.finish).toBeUndefined()
    ledger.complete = false
    await expect(reconcileRuns(ledger, { ...policy, inspect: dead })).rejects.toThrow('complete')
  })
  it('runs the optional harness startup scan and leaves absent ledger inactive', async () => {
    const ctx = new Context(), ledger = new MemoryLedger(ctx, [run()])
    let ready: (() => void) | undefined
    ctx.provide('appReady', { onReady: (callback: () => void) => { ready = callback; return () => { ready = undefined } } })
    // A changed boot identity establishes death without any signal or fake PID probe.
    ledger.runs[0]!.start.processIdentity!.bootIdentity = 'previous-boot'
    apply(ctx, { ...policy, scanOnStart: true })
    expect(ledger.runs[0]!.finish).toBeUndefined()
    await vi.waitFor(() => { expect(ready).toBeTypeOf('function') })
    ready!()
    await vi.waitFor(() =>{  expect(ledger.runs[0]!.finish?.recovered).toBe(true) })
    await ctx.fiber.dispose()
    const absent = new Context()
    apply(absent, { ...policy, scanOnStart: true })
    await absent.fiber.dispose()
  })
  it('owns pending writes through teardown and never overlaps rounds', async () => {
    const ledger = new MemoryLedger(new Context(), [run()])
    let release!: () => void
    ledger.beforeFinish = () => new Promise<void>((resolve) => { release = resolve })
    const controller = startWatching(ledger, { ...policy, intervalMs: 1, scanOnStart: true,
      inspect: dead, onError: (error) => { throw error } })
    await vi.waitFor(() =>{  expect(release).toBeTypeOf('function') })
    let stopped = false
    const stopping = controller.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(ledger.runs[0]!.finish?.recovered).toBe(true)
  })
  it.runIf(process.platform === 'linux')('records a real registered child SIGKILL within ten seconds', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} })
    const exited = once(child, 'exit')
    await once(child, 'spawn')
    const pid = child.pid!
    const row = run('real-child')
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const startIdentity = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]!
    row.start.processIdentity = { nodeId: policy.nodeId, pid, startIdentity,
      bootIdentity: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), registeredAt: Date.now(), verification: 'verified' }
    const ledger = new MemoryLedger(new Context(), [row])
    let reportReady!: () => void
    const recovered = new Promise<void>((resolve) => { reportReady = resolve })
    const reports: Awaited<ReturnType<typeof reconcileRuns>>[] = []
    const controller = startWatching(ledger, { ...policy, scanOnStart: true,
      onRound: (report) => { reports.push(report); if (report.recoveries.length) reportReady() }, onError: (error) => { throw error } })
    try {
      expect((await inspectProcessIdentity(row.start.processIdentity, policy.nodeId)).liveness).toBe('confirmed')
      const killedAt = Date.now()
      expect(child.kill('SIGKILL')).toBe(true)
      await exited
      await recovered
      const acknowledgement = reports.flatMap(report => report.recoveries)[0]!
      expect(acknowledgement.persistedAt - killedAt).toBeLessThanOrEqual(10000)
      expect(acknowledgement.latencyMs).toBeLessThanOrEqual(10000)
      expect(row.finish).toMatchObject({ endReason: 'killed', recovered: true })
      process.stderr.write(JSON.stringify({ fixture: 'real-child-kill', pid, signal: 'SIGKILL', killedAt, ...acknowledgement }) + '\n')
    } finally {
      await controller.stop()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })
})
