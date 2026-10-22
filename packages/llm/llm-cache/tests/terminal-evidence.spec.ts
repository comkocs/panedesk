/** Physical-call evidence is separate from upstream Session usage. */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmAdapter } from '@panedesk/dsh-llm'
import type { Context } from '@panedesk/cordis'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { consume, harness } from './harness.ts'
import { cacheRemaining } from '../src/state.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('ledger terminal evidence consumption', () => {
  it.each([{ retention: '24h', seconds: 86400, source: 'response' },
    { retention: 'provider-default', seconds: 43200, source: 'request-estimate' }])
  ('uses returned retention $retention for cache time without guessing a write price', async ({ retention, seconds, source }) => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' }, cacheRetention: '12h',
      cacheWriteTiering: { kind: 'tiered', short: '30m', long: '12h' } }
    adapter.chunks = [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 1 } }, finish]
    LlmAdapter.ledgerEvidence?.set(finish, { reportedCacheRetention: retention })
    await consume(ctx)
    const cache = ledger?.ends[0]?.cache
    expect(cache).toMatchObject({ reportedRetention: retention, retention: { retention: '12h' }, ttlSeconds: seconds,
      ttlSource: source, writePriceTier: 'unknown' })
    expect(ledger?.ends[0]?.cacheWriteTiering).toEqual({ kind: 'unknown' })
    expect(cacheRemaining(cache, cache?.lastCacheEvidenceAt ?? 0)).toMatchObject({ kind: 'estimated', seconds })
  })

  it('records explicit zero counters and reasoning without changing emitted usage', async () => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    adapter.chunks = [{ type: 'usage', usage }, finish]
    LlmAdapter.ledgerEvidence?.set(finish, { usageObserved: true,
      usage: { ...usage, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reportedUsage: { prompt_tokens: 10, completion_tokens: 2, reasoning_tokens: 3, total_tokens: 15 } })
    expect((await consume(ctx)).find(chunk => chunk.type === 'usage')).toEqual({ type: 'usage', usage })
    expect(ledger?.ends[0]).toMatchObject({ usageState: 'complete', usage: { outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reportedUsage: { reasoning_tokens: 3 } })
  })

  it.each(['deepseek', 'glm', 'grok'])('counts %s adapter-declared inapplicable writes as complete', async (family) => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' }, responseModel: `${family}-model-a`,
      cacheWriteTiering: { kind: 'untiered' } }
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 }
    adapter.chunks = [{ type: 'usage', usage }, finish]
    LlmAdapter.ledgerEvidence?.set(finish, { cacheWriteAccounting: 'not-applicable', usage: { ...usage, cacheWriteTokens: 0 } })
    await consume(ctx)
    expect(ledger?.ends[0]).toMatchObject({ cacheWriteAccounting: 'not-applicable', usageState: 'complete',
      usage: { cacheWriteTokens: 0 }, cacheWriteTiering: { kind: 'untiered' } })
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it.each(['gpt-5.6', 'claude-model-a'].flatMap(model => [undefined, 0].map(write => ({ model, write }))))
  ('$model keeps missing writes partial and reported $write unchanged', async ({ model, write }) => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' }, responseModel: model,
      cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' } }
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, ...write === undefined ? {} : { cacheWriteTokens: write } }
    adapter.chunks = [{ type: 'usage', usage }, finish]
    await consume(ctx)
    expect(ledger?.ends[0]?.usageState).toBe(write === undefined ? 'partial' : 'complete')
    expect(ledger?.ends[0]?.usage?.cacheWriteTokens).toBe(write)
    expect(ledger?.ends[0]).not.toHaveProperty('cacheWriteAccounting')
  })

  it('does not turn a pre-network failure into complete zero usage', async () => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'Invalid request' } } }
    adapter.chunks = [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, finish]
    LlmAdapter.ledgerEvidence?.set(finish, { usageObserved: false })
    await consume(ctx)
    expect(ledger?.ends[0]).toMatchObject({ usageState: 'missing', pricingState: 'missing-usage', endReason: 'error' })
    expect(ledger?.ends[0]).not.toHaveProperty('usage')
  })
})
