/** Wire evidence and opt-in cache controls through the real SDK transport. */
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@panedesk/dsh-brand'
import { LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { PiResponseEvidence } from '../src/stream.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicFrame, anthropicTextEvents, closeMockServers, mockServer, textEvents } from './mock-server.ts'

type Api = 'anthropic-messages' | 'openai-responses' | 'openai-completions'
const apis: Api[] = ['anthropic-messages', 'openai-responses', 'openai-completions']
afterEach(closeMockServers)

function frames(api: Api, model: string | undefined) {
  if (api === 'anthropic-messages') return [
    anthropicFrame({ type: 'message_start', message: {
      id: 'msg-a', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } },
    } }), ...anthropicTextEvents.slice(1),
  ]
  if (api === 'openai-completions') return textEvents.map((event) => {
    if (event === '[DONE]') return event
    const parsed = JSON.parse(event) as Record<string, unknown>
    return JSON.stringify({ ...parsed, model, ...parsed.usage === undefined ? {} : {
      usage: { prompt_tokens: 37, completion_tokens: 1, total_tokens: 38,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 7 } },
    } })
  })
  const item = { type: 'message', id: 'msg-a', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
  return [
    { type: 'response.created', response: { id: 'resp-a', model } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp-a', model, status: 'completed', output: [item],
      usage: { input_tokens: 37, output_tokens: 1, total_tokens: 38, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 7 } },
    } },
  ].map(event => JSON.stringify(event))
}

function adapter(api: Api, url: string, model: string, displayName?: string) {
  const profiles = resolveProfiles({ 'route-a': { api, baseURL: url, models: [{ id: model }], ...displayName === undefined ? {} : { displayName } } })
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'fixture-key', auth: memoryAuth() })
}

async function collect(llm: PiAiAdapter, model: string, controls: Partial<GenerateOptions> = {}) {
  const chunks: StreamChunk[] = []
  for await (const chunk of llm.stream({ provider: 'route-a', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...controls })) chunks.push(chunk)
  return { finish: chunks.find(chunk => chunk.type === 'finish'), usage: chunks.find(chunk => chunk.type === 'usage')?.usage }
}

describe('provider response evidence', () => {
  it('keeps returned retention separate and encodes non-ASCII session headers deterministically', async () => {
    const events = frames('openai-responses', 'gpt-5.6').map((event) => {
      if (typeof event !== 'string') throw new Error('Expected response frame')
      const raw = JSON.parse(event) as { response?: Record<string, unknown> }
      return JSON.stringify({ ...raw, ...raw.response === undefined ? {} : { response: { ...raw.response, prompt_cache_retention: '24h' } } })
    })
    const server = await mockServer([0, 1, 2].map(() => ({ events })))
    const llm = adapter('openai-responses', server.url, 'gpt-5.6')
    const sessions = ['seat-é', 'seat-é', 'seat-a']
    for (const session of sessions) {
      const result = await collect(llm, 'gpt-5.6', { sessionId: brandString<NonNullable<GenerateOptions['sessionId']>>(session), cache: { retention: '12h' } })
      expect(result.finish).toMatchObject({ reason: { kind: 'stop' }, cacheRetention: '12h' })
      expect(result.finish).not.toHaveProperty('reportedCacheRetention')
      expect(result.finish && LlmAdapter.ledgerEvidence?.get(result.finish)).toMatchObject({ reportedCacheRetention: '24h' })
    }
    expect(server.headers.map(headers => headers.session_id)).toEqual(sessions.map(session => encodeURIComponent(session)))
    expect(server.requests[0]).toMatchObject({ prompt_cache_key: sessions[0] })
  })
  it.each(['deepseek-model-a', 'glm-model-a', 'grok-model-a'])
  ('declares cache writes not applicable for %s without changing stream usage', async (model) => {
    const events = textEvents.map((event) => {
      if (event === '[DONE]') return event
      const parsed = JSON.parse(event) as Record<string, unknown>
      return JSON.stringify({ ...parsed, model,
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 0 } } })
    })
    const server = await mockServer([{ events }])
    const result = await collect(adapter('openai-completions', server.url, model), model)
    expect(result.finish && LlmAdapter.ledgerEvidence?.get(result.finish)).toMatchObject({
      cacheWriteAccounting: 'not-applicable', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(result.usage).not.toHaveProperty('cacheWriteTokens')
    expect(result.finish).not.toHaveProperty('cacheWriteAccounting')
  })

  it.each(apis.flatMap(api => ['model-a', 'model-b', undefined].map(model => ({ api, model }))))
  ('$api reports wire model $model without substituting the requested model', async ({ api, model }) => {
    const server = await mockServer([{ events: frames(api, model) }])
    const result = await collect(adapter(api, server.url, 'model-a', 'account-a'), 'model-a')
    expect(result.finish).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, httpStatus: 200, accountLabel: 'account-a',
      responseModelReported: model === undefined ? 'missing' : model === 'model-a' ? 'same' : 'different' })
    if (model === undefined) expect(result.finish).not.toHaveProperty('responseModel')
    else expect(result.finish?.responseModel).toBe(model)
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 7, totalTokens: 38 })
    if (api === 'anthropic-messages') expect(result.usage?.cacheWriteLongTokens).toBe(4)
  })

  it.each(apis.flatMap(api => [429, 503].map(status => ({ api, status }))))
  ('$api retains HTTP $status without adding SDK retries', async ({ api, status }) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: 'busy', type: 'server_error' } }) }])
    const result = await collect(adapter(api, server.url, 'model-a'), 'model-a')
    expect(result.finish).toMatchObject({ httpStatus: status, accountLabel: 'route-a',
      responseModelReported: 'unobservable', reason: { kind: 'error', failure: { status } } })
    expect(server.requests).toHaveLength(1)
  })

  it('does not infer evidence from an unobservable API or an initialized SDK model', () => {
    const evidence = new PiResponseEvidence('model-a', 'google-generative-ai')
    evidence.observe({ model: 'model-b' })
    expect(evidence.enrich({ type: 'finish', reason: { kind: 'stop' } }, {})).toEqual({
      type: 'finish', reason: { kind: 'stop' }, responseModelReported: 'unobservable',
    })
  })
})

describe('opt-in wire cache controls', () => {
  it.each(['none', '5m', '1h', 'default'] as const)('applies Anthropic %s retention on existing breakpoints', async (retention) => {
    const server = await mockServer([{ events: frames('anthropic-messages', 'claude-model-a') }])
    const result = await collect(adapter('anthropic-messages', server.url, 'claude-model-a'), 'claude-model-a', {
      system: 'stable prefix', cache: { retention }, tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
    })
    const payload = JSON.stringify(server.requests[0])
    expect(result.finish).toMatchObject({ cacheRetention: retention === 'default' ? '1h' : retention,
      cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' } })
    if (retention === 'none') expect(payload).not.toContain('cache_control')
    else expect(payload).toContain(`"cache_control":{"type":"ephemeral","ttl":"${retention === 'default' ? '1h' : retention}"}`)
    expect(result.usage).toMatchObject({ cacheWriteTokens: 7, cacheWriteLongTokens: 4 })
  })

  it.each((['openai-responses', 'openai-completions'] as const).flatMap(api =>
    (['30m', '12h', 'default'] as const).map(retention => ({ api, retention }))))
  ('$api applies $retention and stable session keys', async ({ api, retention }) => {
    const server = await mockServer([0, 1, 2].map(() => ({ events: frames(api, 'gpt-5.6') })))
    const llm = adapter(api, server.url, 'gpt-5.6')
    const effective = api === 'openai-completions' || retention === '30m' ? '30m' : '12h'
    for (const session of ['session-a', 'session-a', 'session-b']) {
      const result = await collect(llm, 'gpt-5.6', { sessionId: brandString<NonNullable<GenerateOptions['sessionId']>>(session), cache: { retention } })
      expect(result.finish).toMatchObject({ cacheRetention: effective, cacheWriteTiering: { kind: 'tiered', short: '30m', long: '12h' } })
      if (api === 'openai-completions' && retention !== '30m') expect(result.finish?.cacheDowngradeReason).toBe('non-responses-api')
      else expect(result.finish).not.toHaveProperty('cacheDowngradeReason')
      expect(result.usage).toMatchObject({ inputTokens: 10, cacheWriteTokens: 7, cacheWriteLongTokens: effective === '12h' ? 7 : 0 })
    }
    for (const [index, key] of ['session-a', 'session-a', 'session-b'].entries()) {
      expect(server.requests[index]).toMatchObject({ prompt_cache_options: { ttl: effective }, prompt_cache_key: key })
    }
    for (const request of server.requests) expect(request).not.toHaveProperty('prompt_cache_retention')
  })

  it('honors an explicit cache key and leaves absent controls unchanged', async () => {
    const server = await mockServer([0, 1].map(() => ({ events: frames('openai-responses', 'gpt-5.6') })))
    const llm = adapter('openai-responses', server.url, 'gpt-5.6')
    await collect(llm, 'gpt-5.6', { cache: { retention: '30m', key: 'stable-key' } })
    expect(server.requests[0]).toMatchObject({ prompt_cache_key: 'stable-key' })
    const result = await collect(llm, 'gpt-5.6')
    expect(server.requests[1]).not.toHaveProperty('prompt_cache_options')
    expect(result.finish).not.toHaveProperty('cacheRetention')
    expect(result.usage).not.toHaveProperty('cacheWriteLongTokens')
  })

  it.each(['deepseek-model-a', 'glm-model-a', 'grok-model-a'])('keeps %s untiered without fake cache switches', async (model) => {
    const server = await mockServer([{ events: frames('openai-completions', model) }])
    const result = await collect(adapter('openai-completions', server.url, model), model, { cache: { retention: 'auto' } })
    expect(result.finish).toMatchObject({ cacheWriteTiering: { kind: 'untiered' } })
    expect(result.usage).not.toHaveProperty('cacheWriteLongTokens')
    expect(server.requests[0]).not.toHaveProperty('prompt_cache_options')
    expect(server.requests[0]).not.toHaveProperty('cache_control')
  })

  it.each([
    ['anthropic-messages', 'claude-model-a', '12h'], ['openai-responses', 'gpt-5.6', '1h'],
    ['openai-completions', 'gpt-5.5', '12h'], ['openai-completions', 'glm-model-a', 'none'],
  ] as const)('rejects unsupported retention %s/%s/%s before network dispatch', async (api, model, retention) => {
    const server = await mockServer([])
    await expect(collect(adapter(api, server.url, model), model, { cache: { retention } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(server.requests).toHaveLength(0)
  })
})
