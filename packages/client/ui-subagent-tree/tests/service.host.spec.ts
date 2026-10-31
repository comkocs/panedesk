/** Host Remote authorization, transcript read chain, and cancellation behavior. */
import { Context } from '@panedesk/cordis'
import { describe, expect, it } from 'vitest'
import type { LedgerLifecycle, LedgerRow, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { SessionLedger } from '@panedesk/dsh-session-ledger'
import type { AssistantMessage } from '@panedesk/dsh-llm'
import type { SessionEvent, SessionId } from '@panedesk/dsh-session/types'
import SubagentTreeService from '../src/index.ts'

const startedAt = Date.parse('2026-10-31T04:00:00Z')
const asOf = startedAt + 60000
const ROOT = 'session/root' as SessionId
const CHILD = 'session/child' as SessionId

class MemoryLedger extends SessionLedger {
  override resolveCallContext: SessionLedger['resolveCallContext'] = () => { throw new Error('Read-only fixture') }
  override bindContext: SessionLedger['bindContext'] = () => { throw new Error('Read-only fixture') }
  override contextFor: SessionLedger['contextFor'] = () => undefined
  override nodeId: SessionLedger['nodeId'] = () => { throw new Error('Read-only fixture') }
  override importNode: SessionLedger['importNode'] = () => { throw new Error('Read-only fixture') }
  constructor(ctx: Context, private readonly data: LedgerSnapshot) { super(ctx) }
  override async snapshot() { return this.data }
  override async query() { return this.data }
  override beginCall(): never { throw new Error('Read-only fixture') }
  override finishCall(): never { throw new Error('Read-only fixture') }
  override beginRun(): never { throw new Error('Read-only fixture') }
  override finishRun(): never { throw new Error('Read-only fixture') }
  override appendEvent(): never { throw new Error('Read-only fixture') }
  override appendArtifact(): never { throw new Error('Read-only fixture') }
  override finishArtifact(): never { throw new Error('Read-only fixture') }
  override registerWaitTool(): never { throw new Error('Read-only fixture') }
  override priceUsage(): never { throw new Error('Read-only fixture') }
}

/** A running root with one child call that carries usage, matching ledger parent-child facts. */
function ledgerFixture(): LedgerSnapshot {
  const identity = { rootSessionId: ROOT, seat: 'seat-a', window: 'window-a', accountLabel: 'account-a',
    nodeId: 'node-a' as LedgerLifecycle['start']['nodeId'], identitySource: 'startup' as const }
  const rows: LedgerRow[] = [
    { kind: 'run', start: { ...identity, sessionId: ROOT, runId: 'run-root' as never,
      startedAt, launchState: 'started', deliveryPaths: [] }, liveness: 'confirmed' },
    { kind: 'run', start: { ...identity, sessionId: CHILD, parentSessionId: ROOT, runId: 'run-child' as never,
      startedAt, launchState: 'started', deliveryPaths: [] }, liveness: 'confirmed' },
    { kind: 'call', start: { ...identity, sessionId: CHILD, parentSessionId: ROOT, callId: 'call-1' as never, runId: 'run-child' as never,
      logicalRequestId: 'request-1' as never, attemptIndex: 0, attemptVisibility: 'physical', provider: 'p', modelFamily: 'f',
      requestedModel: 'requested-a', purpose: 'conversation', startedAt, cache: { cacheMode: 'explicit', breakReasons: [] },
      cacheWriteTiering: { kind: 'untiered' }, priceVersion: 'v1', priceKey: 'requested-a', referencePrice: true },
    finish: { callId: 'call-1' as never, endedAt: startedAt + 1000, observedAt: startedAt + 1000, effectiveModel: 'ledger-model-a',
      responseModelReported: 'same', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 8 },
      usageState: 'complete', pricingState: 'priced', wallMs: 1000, modelInFlightMs: 1000, queueMs: 0, backoffMs: 0,
      waits: [], compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false } },
  ]
  return { asOf, rows, complete: true, watermarks: {} }
}

function transcriptLog(model: string): { inheritedEventCount: number; events: SessionEvent[] } {
  const assistant: SessionEvent<'assistant/message'> = { type: 'assistant/message', seq: 2 as SessionEvent['seq'],
    time: startedAt + 10, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: 'm-1' as AssistantMessage['id'], role: 'assistant', content: [],
      source: { kind: 'model', provider: 'p', model } }, stream: [] } }
  const toolCall: SessionEvent<'tool/call'> = { type: 'tool/call', seq: 3 as SessionEvent['seq'], time: startedAt + 20,
    data: { turn: 1, step: 1, callId: 'c-1' as SessionEvent<'tool/call'>['data']['callId'], name: 'fs_read', arguments: '{}' } }
  return { inheritedEventCount: 0, events: [assistant, toolCall] }
}

function ownerContext(
  ledger?: LedgerSnapshot,
  readSession?: (sessionId: SessionId) => Promise<{ inheritedEventCount: number; events: SessionEvent[] }>,
  signal?: AbortSignal,
): Context {
  const ctx = new Context()
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: {
    peer: { principal: { kind: 'owner' } }, signal: signal ?? new AbortController().signal,
  } })
  if (ledger !== undefined) new MemoryLedger(ctx, ledger)
  if (readSession !== undefined) ctx.provide('sessionQuery', { readSession } as never)
  return ctx
}

describe('subagent tree host remote', () => {
  it('rejects callers without an authenticated owner principal', async () => {
    const ctx = ownerContext(ledgerFixture())
    Object.defineProperty(ctx, 'invocation', { configurable: true, value: {
      peer: { principal: { kind: 'anonymous' } }, signal: new AbortController().signal,
    } })
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 5000 })
    await expect(service.read({ sessionId: CHILD })).rejects.toThrow('Authenticated owner required')
  })

  it('rejects reads while the deployment disables the tree', async () => {
    const ctx = ownerContext(ledgerFixture())
    const service = new SubagentTreeService(ctx, { enabled: false, refreshIntervalMs: 5000 })
    await expect(service.read({ sessionId: CHILD })).rejects.toThrow('disabled')
  })

  it('rejects reads whose invocation signal aborted', async () => {
    const abort = new AbortController()
    const ctx = ownerContext(ledgerFixture(), undefined, abort.signal)
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 5000 })
    abort.abort()
    await expect(service.read({ sessionId: CHILD })).rejects.toThrow('unavailable')
  })

  it('reads the model strictly from the session transcript and passes monitoring facts through', async () => {
    const ctx = ownerContext(ledgerFixture(), async sessionId =>
      sessionId === CHILD ? transcriptLog('transcript-model-x') : { inheritedEventCount: 0, events: [] })
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 2500 })
    const view = await service.read({ sessionId: ROOT })
    expect(view).toMatchObject({ asOf, complete: true, refreshIntervalMs: 2500 })
    expect(view.root.sessionId).toBe(ROOT)
    expect(view.root).toMatchObject({ model: null, modelSource: 'transcript' })
    expect(view.root.children).toHaveLength(1)
    const child = view.root.children[0]!
    expect(child).toMatchObject({ sessionId: CHILD, status: 'running', model: 'transcript-model-x', modelSource: 'transcript' })
    expect(child.lastToolCall).toEqual({ name: 'fs_read', time: startedAt + 20 })
    expect(child.tokens).toMatchObject({ inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 8 })
  })

  it('keeps the model unknown when no session-query engine is deployed', async () => {
    const ctx = ownerContext(ledgerFixture())
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 5000 })
    const view = await service.read({ sessionId: ROOT })
    expect(view.root.children[0]).toMatchObject({ model: null, modelSource: 'unavailable', lastToolCall: null })
    expect(view.root).toMatchObject({ model: null, modelSource: 'unavailable' })
  })

  it('keeps the model unknown when the session log cannot be read', async () => {
    const ctx = ownerContext(ledgerFixture(), async () => { throw new Error('log unreadable') })
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 5000 })
    const view = await service.read({ sessionId: ROOT })
    expect(view.root.children[0]).toMatchObject({ model: null, modelSource: 'unreadable' })
  })

  it('serves an empty tree over an absent ledger without failing', async () => {
    const ctx = ownerContext()
    const service = new SubagentTreeService(ctx, { enabled: true, refreshIntervalMs: 5000 })
    const view = await service.read({ sessionId: ROOT })
    expect(view.complete).toBe(false)
    expect(view.root).toMatchObject({ sessionId: ROOT, children: [], runs: 0, calls: 0 })
  })
})
