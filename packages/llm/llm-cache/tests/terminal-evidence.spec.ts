/** Physical-call evidence is separate from upstream Session usage. */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmAdapter } from '@panedesk/dsh-llm'
import type { Context } from '@panedesk/cordis'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { consume, harness } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('ledger terminal evidence consumption', () => {
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
