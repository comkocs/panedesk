import { describe, expect, it } from 'vitest'
import { brandString } from '@panedesk/dsh-brand'
import type { LedgerEvent, LedgerRunFinish, LedgerSessionContext, LedgerWatermark } from '@panedesk/dsh-session-ledger'
import type { SubprocessHandle, SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { recordExternalRun, type ExternalLedgerSpec } from '../src/ledger.ts'

function fixture() {
  const events: LedgerEvent[] = []
  const finishes: LedgerRunFinish[] = []
  const parent: LedgerSessionContext = {
    seat: 'seat', window: 'window', nodeId: brandString<LedgerSessionContext['nodeId']>('node'), identitySource: 'startup',
    sessionId: brandString<LedgerSessionContext['sessionId']>('parent'), rootSessionId: brandString<LedgerSessionContext['sessionId']>('root'),
    runId: brandString<LedgerSessionContext['runId']>('parent-run'), accountLabel: 'unknown',
  }
  const append = async (event: LedgerEvent) => {
    events.push(event)
    return { kind: 'appended' as const, event, watermark: brandString<LedgerWatermark>(String(events.length)) }
  }
  const done = Promise.withResolvers<SubprocessOutcome>()
  const child: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: done.promise,
    processIdentity: { pid: 123, processGroupId: 123, startIdentity: '456', bootIdentity: 'test-boot' },
    terminate: () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    waitForExit: async () => { await done.promise; return true },
  }
  const spec: ExternalLedgerSpec = {
    parentContext: parent, spawn: () => child,
    ledger: {
      beginRun: input => append({ schemaVersion: 1, eventId: brandString<LedgerEvent['eventId']>('start'), nodeId: parent.nodeId,
        observedAt: Date.now(), runId: input.runId, sessionId: input.sessionId, kind: 'run/start', data: input }),
      appendEvent: append,
      finishRun: (input) => {
        finishes.push(input)
        return append({ schemaVersion: 1, eventId: brandString<LedgerEvent['eventId']>('end'), nodeId: parent.nodeId,
          observedAt: Date.now(), runId: input.runId, sessionId: brandString<LedgerSessionContext['sessionId']>('child'), kind: 'run/end', data: input })
      },
    },
  }
  const spawn = (observed: ExternalLedgerSpec) => observed.spawn({ argv: ['fixture'], cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 10 })
  return { spec, done, events, finishes, spawn }
}

describe('optional external lifecycle ledger', () => {
  it('records real identity and aggregate usage without enforcing definitions or adding calls', async () => {
    const f = fixture()
    const run = await recordExternalRun({ signal: new AbortController().signal }, f.spec, async (spec) => {
      f.spawn(spec)
      spec.observeUsage?.({ inputTokens: 5, outputTokens: 3 })
      return { id: brandString<LedgerSessionContext['sessionId']>('backend-id'), result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
        dispose: async () => { f.done.resolve({ exitCode: 0, signal: null }) } }
    })
    await run.result
    await Promise.all([run.dispose(), run.dispose()])
    expect(f.events.map(event => event.kind)).toEqual(['run/start', 'process/observed', 'run/end'])
    expect(f.finishes).toHaveLength(1)
    expect(f.finishes[0]).toMatchObject({ endReason: 'completed', externalBackend: {
      definitionEnforcement: 'not-applicable', usage: { inputTokens: 5, outputTokens: 3 }, processIdentityState: 'reported',
    } })
  })

  it('closes a killed process once without waiting for protocol settlement', async () => {
    const f = fixture()
    const run = await recordExternalRun({ signal: new AbortController().signal }, f.spec, async (spec) => {
      f.spawn(spec)
      return { id: brandString<LedgerSessionContext['sessionId']>('backend-id'), result: new Promise(() => {}), dispose: async () => {} }
    })
    const before = performance.now()
    f.done.resolve({ exitCode: null, signal: 'SIGKILL' })
    await expect.poll(() => f.finishes.length).toBe(1)
    expect(performance.now() - before).toBeLessThan(1000)
    await run.dispose()
    expect(f.finishes).toHaveLength(1)
    expect(f.finishes[0]).toMatchObject({ endReason: 'killed', signal: 'SIGKILL', externalBackend: { usageState: 'missing' } })
    expect(f.finishes[0]?.externalBackend?.usage).toBeUndefined()
  })

  it('does not relabel an upstream error as cancellation during disposal', async () => {
    const f = fixture()
    const run = await recordExternalRun({ signal: new AbortController().signal }, f.spec, async (spec) => {
      const child = f.spawn(spec)
      return { id: brandString<LedgerSessionContext['sessionId']>('backend-id'), result: Promise.resolve({ output: [], stopReason: 'error' as const }),
        dispose: async () => { child.terminate() } }
    })
    await run.result
    await run.dispose()
    expect(f.finishes[0]?.endReason).toBe('error')
  })

  it('keeps explicit cancellation distinct from cleanup signals', async () => {
    const f = fixture()
    const controller = new AbortController()
    const run = await recordExternalRun({ signal: controller.signal }, f.spec, async (spec) => {
      const child = f.spawn(spec)
      return { id: brandString<LedgerSessionContext['sessionId']>('backend-id'), result: new Promise(() => {}), dispose: async () => { child.terminate() } }
    })
    controller.abort()
    await run.dispose()
    expect(f.finishes[0]?.endReason).toBe('cancelled')
  })

  it('records missing process evidence and startup failure without fabricated usage', async () => {
    const f = fixture()
    await expect(recordExternalRun({ signal: new AbortController().signal }, f.spec, async () => {
      throw new Error('spawn failed')
    })).rejects.toThrow('spawn failed')
    expect(f.finishes[0]).toMatchObject({ endReason: 'error', externalBackend: {
      definitionEnforcement: 'not-applicable', usageState: 'missing', processIdentityState: 'not-reported',
    } })
  })

  it('preserves the backend handle when accounting is absent', async () => {
    const run = { id: brandString<LedgerSessionContext['sessionId']>('backend-id'), result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
    expect(await recordExternalRun({ signal: new AbortController().signal }, { spawn: () => { throw new Error('unused') } }, async () => run)).toBe(run)
  })
})
