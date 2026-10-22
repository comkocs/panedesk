/** Ledger-only usage evidence never changes the durable stream vocabulary. */
import { describe, expect, it } from 'vitest'
import { AssistantStreamAccumulator, LlmAdapter } from '@panedesk/dsh-llm'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { PiResponseEvidence } from '../src/stream.ts'

function terminal(raw: unknown, api = 'openai-completions') {
  const evidence = new PiResponseEvidence('model-a', api)
  evidence.observe(raw)
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  expect(evidence.enrich({ type: 'usage', usage }, {})).toEqual({ type: 'usage', usage })
  const finish = evidence.enrich({ type: 'finish', reason: { kind: 'stop' } }, {
    cacheWriteTiering: { kind: 'tiered', short: '30m', long: '12h' }, cacheRetention: '12h',
  })
  return { finish, evidence: LlmAdapter.ledgerEvidence?.get(finish) }
}

describe('ledger terminal usage evidence', () => {
  it('keeps reported zero reads and long writes outside the durable stream', () => {
    const { finish, evidence } = terminal({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } })
    expect(evidence?.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12,
      cacheReadTokens: 0, cacheWriteTokens: 0, cacheWriteLongTokens: 0 })
    const accumulator = new AssistantStreamAccumulator()
    accumulator.push({ time: 1, chunk: finish })
    expect(JSON.stringify(accumulator.snapshot())).not.toContain('reportedUsage')
    expect(JSON.stringify(accumulator.snapshot())).not.toContain('cacheReadTokens')
  })

  it('leaves unreported counters absent and preserves explicit Anthropic zero tiers', () => {
    expect(terminal({ usage: { prompt_tokens: 10, completion_tokens: 2 } }).evidence?.usage)
      .not.toHaveProperty('cacheWriteTokens')
    const evidence = new PiResponseEvidence('model-a', 'anthropic-messages')
    evidence.observe({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } } } })
    evidence.observe({ type: 'message_delta', usage: { output_tokens: 2 } })
    evidence.enrich({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, {})
    const finish = evidence.enrich({ type: 'finish', reason: { kind: 'stop' } }, {})
    expect(LlmAdapter.ledgerEvidence?.get(finish)?.usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, cacheWriteLongTokens: 0 })
  })

  it.each([{ total: 15, output: 5 }, { total: 12, output: 2 }, { total: 14, output: 2 }])
  ('includes reasoning only when the wire total proves disjoint completion: $total', ({ total, output }) => {
    const { evidence } = terminal({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: total,
      completion_tokens_details: { reasoning_tokens: 3 } } })
    expect(evidence?.usage?.outputTokens).toBe(output)
    expect(evidence?.reportedUsage).toMatchObject({ total_tokens: total, 'completion_tokens_details.reasoning_tokens': 3 })
  })

  it('marks synthesized SDK zeros as unobserved on a failure before the network', () => {
    const evidence = new PiResponseEvidence('model-a', 'openai-responses')
    evidence.enrich({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, {})
    const finish: StreamChunk = evidence.enrich({ type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Request construction failed' } } }, {})
    expect(LlmAdapter.ledgerEvidence?.get(finish)).toEqual({ usageObserved: false })
  })
})
