/** Full-ledger ownership is independent of optional cache registration order. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { LlmAdapter, LlmError } from '@panedesk/dsh-llm'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { JournalSessionLedger, tokenColumns } from '@panedesk/dsh-session-ledger'
import type { CallContributor, SessionLedger } from '@panedesk/dsh-session-ledger'
import * as Cache from '../src/index.ts'
import { harness } from './harness.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function setup(order: 'none' | 'ledger-first' | 'cache-first') {
  const home = await mkdtemp(join(import.meta.dirname, '.call-accounting-'))
  homes.push(home)
  const { ctx, adapter } = await harness({ ledger: false, cache: order === 'cache-first' })
  contexts.push(ctx)
  await ctx.plugin(JournalSessionLedger, { dshHome: home })
  if (order === 'ledger-first') await ctx.plugin(Cache, {
    policy: { retention: 'default' },
    keepalive: { enabled: false, leadSeconds: 240, minimumIntervalSeconds: 60, maxOutputTokens: 1 },
    concurrency: [],
  })
  const ledger = ctx.sessionLedger
  const request = { provider: 'model-provider', model: 'claude-sonnet-5-5', messages: [], sessionId: SessionId('accounted-session') }
  async function consume(signal?: AbortSignal) {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ ...request, ...signal === undefined ? {} : { signal } })) chunks.push(chunk)
    return chunks
  }
  return { ctx, adapter, ledger, home, consume }
}

const observed = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 8, cacheWriteLongTokens: 3 }
function observedChunks(): StreamChunk[] {
  const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' }, responseModel: 'claude-sonnet-5-5',
    responseModelReported: 'same', cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' } }
  LlmAdapter.ledgerEvidence?.set(finish, { usageObserved: true, usage: observed, reportedUsage: { reasoning_tokens: 3 } })
  return [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, finish]
}

async function expectObserved(ledger: SessionLedger) {
  const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.finish).toMatchObject({ endReason: 'completed', usage: observed, usageState: 'complete',
    priceVersion: 'reference-v1', priceKey: 'claude-sonnet-5-5', priceKeySource: 'response-model',
    costUsd: '0.0000965', pricingState: 'priced', reportedUsage: { reasoning_tokens: 3 } })
  expect(tokenColumns({ usage: row.finish!.usage, usageState: row.finish!.usageState,
    tiering: row.finish!.cacheWriteTiering!, startedAt: row.start.startedAt })).toEqual({
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 8,
    cacheWriteShortTokens: 5, cacheWriteLongTokens: 3, cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' },
  })
}

describe('full ledger call accounting', () => {
  function contributor() {
    const prepare = vi.fn<CallContributor['prepare']>(async () => ({
      evidence: { cacheMode: 'disabled', breakReasons: [] }, modelFamily: 'test-family',
      signal: new AbortController().signal,
      started: async () => {}, acquire: async () => () => {}, terminal: () => {},
      interjected: async () => {}, settled: async () => {}, dispose: () => {},
    }))
    return { prepare }
  }

  it('unregisters call contributions with the owning plugin fiber', async () => {
    const { ctx, adapter, ledger, consume } = await setup('none')
    const value = contributor()
    const fiber = await ctx.plugin((child) => { child.effect(() => ledger.registerCallContributor(value)) })
    adapter.chunks = observedChunks()
    await consume()
    expect(value.prepare).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    await consume()
    expect(value.prepare).toHaveBeenCalledTimes(1)
    expect((await ledger.snapshot()).rows.filter(row => row.kind === 'call')).toHaveLength(2)
  })

  it('rejects duplicate call contributor registrations without releasing the live owner', async () => {
    const { adapter, ledger, consume } = await setup('none')
    const value = contributor()
    const release = ledger.registerCallContributor(value)
    expect(() => ledger.registerCallContributor(value)).toThrow('already registered')
    expect(() => ledger.registerCallContributor(contributor())).toThrow('already registered')
    adapter.chunks = observedChunks()
    await consume()
    expect(value.prepare).toHaveBeenCalledTimes(1)
    release()
    release()
    const replacement = contributor()
    const releaseReplacement = ledger.registerCallContributor(replacement)
    release()
    await consume()
    expect(replacement.prepare).toHaveBeenCalledTimes(1)
    releaseReplacement()
  })

  it('records calls with the session ledger and no cache plugin', async () => {
    const { adapter, ledger, consume } = await setup('none')
    adapter.chunks = observedChunks()
    const chunks = await consume()
    expect(chunks[0]).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
    await expectObserved(ledger)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    LlmAdapter.ledgerEvidence?.set(finish, { usageObserved: false })
    adapter.chunks = [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, finish]
    await consume()
    const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
    expect(rows).toHaveLength(2)
    const missing = rows.find(row => row.finish?.usageState === 'missing')
    expect(missing?.finish).toMatchObject({ usageState: 'missing', pricingState: 'missing-usage' })
    expect(missing?.finish).not.toHaveProperty('usage')
  })

  it.each(['ledger-first', 'cache-first'] as const)('records exactly one call when ledger and cache plugins coexist (%s)', async (order) => {
    const { adapter, ledger, consume } = await setup(order)
    adapter.chunks = observedChunks()
    await consume()
    await expectObserved(ledger)
  })

  it.each(['none', 'cache-first'] as const)('preserves terminal status and observed usage after cancellation or failure (%s)', async (order) => {
    const { adapter, ledger, home, consume } = await setup(order)
    const seen = new Set<string>()
    for (const mode of ['cancelled', 'error', 'timeout', 'interjection'] as const) {
      const abort = new AbortController()
      adapter.stream = async function* () {
        yield { type: 'text-delta', index: 0, text: mode }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 } }
        if (mode === 'cancelled' || mode === 'interjection') abort.abort({ kind: mode })
        throw new LlmError('Interrupted fixture stream', mode === 'error' ? 'SERVER' : 'TIMEOUT')
      }
      await consume(abort.signal)
      const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
      const row = rows.find(row => !seen.has(row.start.callId))
      expect(row).toBeDefined()
      seen.add(row!.start.callId)
      expect(row?.finish).toMatchObject({ endReason: mode === 'interjection' ? 'cancelled' : mode,
        usageState: 'partial', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 } })
      expect(row?.finish?.timeoutSource).toBe(mode === 'timeout' ? 'model-call' : undefined)
      if (mode === 'interjection') expect(row?.finish?.upstreamStopReason).toBe('interjection')
      const artifact = row?.finish?.artifacts?.find(item => item.kind === 'partial-response')
      expect(artifact).toBeDefined()
      expect((await ledger.finishArtifact(artifact!)).kind).toBe('existing')
      const bytes = await readFile(join(home, 'ledger', 'v1', row!.start.nodeId, artifact!.path), 'utf8')
      expect(bytes).toContain(mode)
    }
  })
})
