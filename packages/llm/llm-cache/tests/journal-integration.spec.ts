import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
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
async function setup() {
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
  await ledger.beginRun({ ...context, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  return { ...value, ledger, home, context }
}

describe('cache journal integration', () => {
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
    const { ctx, adapter, ledger } = await setup()
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
      if (args[1] === 'wx' && String(args[0]).includes('/events/') && !held) {
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
