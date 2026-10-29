import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage, LlmAdapter } from '@panedesk/dsh-llm'
import type { ToolCallId } from '@panedesk/dsh-llm'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import type { LedgerRunId } from '@panedesk/dsh-session-ledger'
import { harness, consume } from './harness.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })))
})
async function setup(runOwner: 'fixture' | 'agent-loop' = 'fixture') {
  const home = await fs.mkdtemp(join(import.meta.dirname, '.durable-cache-'))
  homes.push(home)
  const value = await harness({ ledger: false, config: {
    routes: [{ provider: 'model-provider', modelFamily: 'family-a', capability: 'openai-chat' }],
  } })
  contexts.push(value.ctx)
  await value.ctx.plugin(JournalSessionLedger, { dshHome: home })
  const ledger = value.ctx.sessionLedger
  const context = { sessionId: SessionId('session-a'), rootSessionId: SessionId('root-a'),
    runId: 'run-a' as LedgerRunId, nodeId: await ledger.nodeId(), seat: 'seat-a', window: 'window-a',
    identitySource: 'startup' as const, accountLabel: 'route-a' }
  ledger.bindContext(context)
  if (runOwner === 'fixture') {
    await ledger.beginRun({ ...context, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  }
  return { ...value, ledger, home, context }
}

describe('cache journal integration', () => {
  it.each([
    { requested: 'grok-4.7', reported: 'grok-4.7-build', key: 'grok-4.7', source: 'request-model', cost: '0.000026' },
    { requested: 'grok-4.7', reported: 'glm-5.3-flash', key: 'glm-5.3-flash', source: 'response-model', cost: '0.000002' },
    { requested: 'model-a', reported: 'grok-4.7', key: 'grok-4.7', source: 'response-model', cost: '0.000026' },
    { requested: 'model-a', reported: 'model-b', key: 'unknown', source: 'unknown', cost: undefined },
  ])('prices ordinary and keepalive calls using exact keys: $requested / $reported', async ({ requested, reported, key, source, cost }) => {
    const { ctx, adapter, ledger } = await setup()
    adapter.chunks = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' }, responseModel: reported, cacheWriteTiering: { kind: 'untiered' } },
    ]
    for (const purpose of [undefined, 'keepalive'] as const) {
      for await (const chunk of ctx.llm.stream({ provider: 'model-provider', model: requested, messages: [],
        sessionId: SessionId('session-a'), ...purpose === undefined ? {} : { purpose } })) void chunk
    }
    const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.start.priceVersion).toBe('reference-v1')
      expect(row.finish).toMatchObject({ priceVersion: 'reference-v1', priceKey: key, priceKeySource: source,
        pricingState: cost === undefined ? 'missing-price' : 'priced' })
      expect(row.finish?.costUsd).toBe(cost)
    }
  })

  it.each(['deepseek-v4-flash', 'glm-5.3-flash', 'grok-4.7'])
  ('persists and prices not-applicable writes as complete for %s', async (model) => {
    const { ctx, adapter, ledger } = await setup()
    const finish = { type: 'finish' as const, reason: { kind: 'stop' as const }, responseModel: model,
      cacheWriteTiering: { kind: 'untiered' as const } }
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 }
    adapter.chunks = [{ type: 'usage', usage }, finish]
    LlmAdapter.ledgerEvidence?.set(finish, { cacheWriteAccounting: 'not-applicable', usage: { ...usage, cacheWriteTokens: 0 } })
    await consume(ctx)
    const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
    expect(rows[0]?.finish).toMatchObject({ cacheWriteAccounting: 'not-applicable', usageState: 'complete',
      usage: { cacheWriteTokens: 0 }, pricingState: 'priced' })
    expect(rows[0]?.finish?.costUsd).toBeDefined()
  })

  it('projects late tool waits after settlement and journal reopening without altering call facts', async () => {
    const { ctx, adapter, ledger, home, context } = await setup()
    const ids = ['sleep-a', 'child-a'] as ToolCallId[]
    adapter.chunks = ids.map((id, index) => ({ type: 'block-end', index,
      block: { type: 'tool-call', id, name: 'wait', arguments: '{}' } }))
    adapter.chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    await consume(ctx)
    const initial = (await ledger.snapshot()).rows.find(row => row.kind === 'call')
    expect(initial?.finish?.toolCallIds).toEqual(ids)
    expect(initial?.waits).toEqual([])
    const startedAt = (initial?.finish?.endedAt ?? 0) + 1
    for (const [index, kind, durationMs] of [[0, 'sleep', 30000], [1, 'subagent', 20000]] as const) {
      const interval = { kind, toolCallId: ids[index]!, startedAt, endedAt: startedAt + durationMs, durationMs }
      await ledger.appendEvent({ schemaVersion: 1, eventId: `wait-${index}` as import('@panedesk/dsh-session-ledger').LedgerEventId,
        nodeId: context.nodeId, sessionId: context.sessionId, runId: context.runId,
        observedAt: interval.endedAt, kind: 'wait/end', interval })
    }
    const reopenedContext = new Context()
    contexts.push(reopenedContext)
    const reopened = new JournalSessionLedger(reopenedContext, { dshHome: home })
    const snapshot = await reopened.snapshot()
    const call = snapshot.rows.find(row => row.kind === 'call')
    const run = snapshot.rows.find(row => row.kind === 'run')
    expect(call?.finish).toEqual(initial?.finish)
    expect(call?.waitSummary).toEqual({ categories: {
      sleep: { toolCalls: 1, durationMs: 30000 }, subagent: { toolCalls: 1, durationMs: 20000 },
    } })
    expect(run?.waitSummary).toEqual(call?.waitSummary)
    expect((await reopened.finishCall(initial!.finish!)).kind).toBe('existing')
  })

  it('inherits a nonresident parent cache policy from the real journal without copying its evidence clock', async () => {
    const { ctx, adapter, ledger, context } = await setup()
    await ledger.appendEvent({ schemaVersion: 1, eventId: 'cache-parent-a' as import('@panedesk/dsh-session-ledger').LedgerEventId,
      nodeId: context.nodeId, observedAt: Date.now(), runId: context.runId, sessionId: context.sessionId,
      kind: 'cache/evidence', evidence: { cacheMode: 'disabled', breakReasons: [], sessionPolicy: { retention: 'none' } } })
    const child = SessionId('child-a')
    ledger.bindContext({ ...context, sessionId: child, parentSessionId: context.sessionId, runId: 'child-run-a' as LedgerRunId })
    const handle = await ctx.agents.create({ sessionId: child, agentOptions: { provider: 'model-provider', model: 'model-a' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(adapter.requests[0]?.cache?.retention).toBe('none')
      const rows = (await ledger.snapshot({ sessionId: child })).rows.filter(row => row.kind === 'call')
      expect(rows[0]?.start.cache?.sessionPolicy?.retention).toBe('none')
    } finally { await handle.dispose() }
  })
  it('persists bound attribution, adapter evidence and closed sidecars across reopening', async () => {
    const { ctx, adapter, ledger, home, context } = await setup()
    adapter.chunks = [
      { type: 'text-delta', index: 0, text: 'answer' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 } },
      { type: 'finish', reason: { kind: 'stop' }, cacheRetention: '30m', cacheDowngradeReason: 'non-responses-api',
        cacheWriteTiering: { kind: 'untiered' }, accountLabel: 'route-b' },
    ]
    await consume(ctx)
    await consume(ctx, 'keepalive')
    const reopenedContext = new Context()
    contexts.push(reopenedContext)
    const reopened = new JournalSessionLedger(reopenedContext, { dshHome: home })
    expect(reopened.contextFor(context.sessionId)).toBeUndefined()
    expect(await reopened.resolveCallContext({ sessionId: context.sessionId, provider: 'model-provider', model: 'model-a' }))
      .toMatchObject({ context: { seat: context.seat, rootSessionId: context.rootSessionId }, runId: context.runId })
    const rows = (await reopened.snapshot()).rows.filter(row => row.kind === 'call')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.start).toMatchObject(context)
      expect(row.finish).toMatchObject({ accountLabel: 'route-b', cacheWriteTiering: { kind: 'untiered' },
        cache: { retention: { retention: '30m' }, ttlSeconds: 1800, downgradeReason: 'non-responses-api' } })
      for (const reference of row.finish?.artifacts ?? []) {
        expect((await reopened.finishArtifact(reference)).kind).toBe('existing')
      }
    }
    expect(rows.flatMap(row => row.finish?.artifacts ?? []).map(item => item.kind)).toContain('keepalive-request')
    expect((await ledger.snapshot()).complete).toBe(true)
  })

  it('retains the configured chat downgrade when the adapter reports no downgrade field', async () => {
    const { ctx, adapter, ledger } = await setup('agent-loop')
    adapter.chunks = [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' }, cacheRetention: '30m' }]
    const handle = await ctx.agents.create({ sessionId: SessionId('session-a'),
      agentOptions: { provider: 'model-provider', model: 'model-a' } })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(adapter.requests[0]?.cache?.retention).toBe('30m')
      const row = (await ledger.snapshot()).rows.find(item => item.kind === 'call')
      expect(row).toMatchObject({ finish: { cache: { downgradeReason: 'non-responses-api', ttlSeconds: 1800 } } })
    } finally { await handle.dispose() }
  })

  it('waits for real file and directory fsync before dispatch and rejects a failed fsync', async () => {
    const { ctx, adapter, home } = await setup()
    const open = fs.open
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if ((args[1] === 'wx' || args[1] === 'a') && String(args[0]).includes('/events/') && !held) {
        held = true
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          reached.resolve(undefined)
          await release.promise
          await sync()
        })
      }
      return handle
    })
    const pending = consume(ctx)
    try {
      await reached.promise
      expect(adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined) }
    await pending
    expect(adapter.requests).toHaveLength(1)
    vi.restoreAllMocks()
    const before = adapter.requests.length
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'r' && String(args[0]).startsWith(join(home, 'ledger'))) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Directory sync unavailable'))
      }
      return handle
    })
    await expect(consume(ctx)).rejects.toThrow()
    expect(adapter.requests).toHaveLength(before)
  })
})
