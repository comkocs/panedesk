import { afterEach, describe, expect, it } from 'vitest'
import type { MockLlmBehavior, MockLlmServer, MockLlmServerOptions, MockLlmUsage } from '../src/index.ts'
import { startMockLlmServer } from '../src/index.ts'
import { parseMockLlmCliArgs } from '../src/cli.ts'

const running: MockLlmServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

async function start(options: Partial<MockLlmServerOptions> = {}): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence: ['success'], ...options })
  running.push(server)
  return server
}

function messages(server: MockLlmServer, body: object = { model: 'requested-model', messages: [], stream: true }): Promise<Response> {
  return fetch(`${server.baseURL}/v1/messages`, { method: 'POST', body: JSON.stringify(body) })
}

function events(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

function sse(payload: object): string {
  return `event: ${'type' in payload ? payload.type : ''}\ndata: ${JSON.stringify(payload)}\n\n`
}

const legacyStart = sse({
  type: 'message_start',
  message: { id: 'mock-message', type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } },
})
const legacyTextStart = sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const legacyTextDelta = sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } })
const legacyTextStop = sse({ type: 'content_block_stop', index: 0 })
const legacyStop = sse({ type: 'message_stop' })

function legacyTerminal(reason: string, tokens: number): string {
  return sse({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: tokens } })
}

describe('mock ledger evidence options', () => {
  it.each([
    ['success', legacyStart + legacyTextStart + legacyTextDelta + legacyTextStop + legacyTerminal('end_turn', 6) + legacyStop],
    ['slow_success', legacyStart + legacyTextStart + legacyTextDelta + legacyTextStop + legacyTerminal('end_turn', 6) + legacyStop],
    ['wrong_content_type', legacyStart + legacyTextStart + legacyTextDelta + legacyTextStop + legacyTerminal('end_turn', 6) + legacyStop],
    ['max_tokens', legacyStart + legacyTextStart + legacyTextDelta + legacyTextStop + legacyTerminal('max_tokens', 6) + legacyStop],
    ['empty', legacyStart + legacyTerminal('end_turn', 0) + legacyStop],
    ['empty_body', ''],
    ['stream_eof', legacyStart],
    ['partial_eof', legacyStart + legacyTextStart + legacyTextDelta],
    ['malformed_json', 'data: {not-json\n\n' + legacyStop],
    ['malformed_event', sse({ type: 'content_block_start', index: 0, content_block: null }) + legacyStop],
  ] as const)('preserves the complete legacy %s body when options are omitted', async (behavior, expected) => {
    const server = await start({ sequence: [behavior], successText: 'answer', partialText: 'answer', chunkSize: 100, chunkDelayMs: 0 })
    expect(Buffer.from(await (await messages(server)).text())).toEqual(Buffer.from(expected))
  })

  it('reports all Messages cache counters without translating wire field names', async () => {
    const usage = {
      input_tokens: 101,
      output_tokens: 17,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
    }
    const server = await start({ usage })
    const body = events(await (await messages(server)).text())
    expect(body[0]?.message).toEqual({
      id: 'mock-message', type: 'message', role: 'assistant', model: 'mock-model', content: [],
      usage: { ...usage, output_tokens: 0 },
    })
    expect(body.at(-2)?.usage).toEqual({ output_tokens: 17 })
    expect(body.at(-1)).toEqual({ type: 'message_stop' })
  })

  it.each([
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { cache_creation: { ephemeral_5m_input_tokens: 0 } },
    { cache_creation: { ephemeral_1h_input_tokens: 9 } },
    { cache_creation: {} },
    {},
  ])('keeps omitted counters absent and preserves explicit zero counters %#', async (usage: MockLlmUsage) => {
    const server = await start({ usage, successText: 'answer' })
    const body = events(await (await messages(server)).text())
    const { output_tokens: outputTokens, ...inputUsage } = usage
    expect(body[0]?.message).toMatchObject({ usage: { input_tokens: 3, output_tokens: 0, ...inputUsage } })
    expect(body.at(-2)?.usage).toEqual({ output_tokens: outputTokens ?? 6 })
    expect((body[0]?.message as { usage: object }).usage).toEqual({ input_tokens: 3, output_tokens: 0, ...inputUsage })
  })

  it.each(['success', 'empty', 'reasoning_success', 'tool_call_success', 'max_tokens', 'slow_success', 'wrong_content_type'] as const)(
    'uses the configured output count for %s', async (behavior) => {
      const server = await start({ sequence: [behavior], usage: { output_tokens: 37 }, chunkDelayMs: 0 })
      const body = events(await (await messages(server)).text())
      expect(body.at(-2)?.usage).toEqual({ output_tokens: 37 })
    },
  )

  it.each(['requested-model', 'returned-model', null])('returns the configured model %s without changing the request', async (responseModel) => {
    const server = await start({ responseModel })
    const body = events(await (await messages(server)).text())
    const message = body[0]?.message as Record<string, unknown>
    if (responseModel === null) expect(message).not.toHaveProperty('model')
    else expect(message.model).toBe(responseModel)
    expect(server.requests[0]?.body).toMatchObject({ model: 'requested-model' })
  })

  it('captures cache controls, lifetimes, and cache keys in FIFO order across a retry sequence', async () => {
    const server = await start({ sequence: ['rate_limit', 'service_unavailable', 'server_error', 'success'] })
    const bodies = ['5m', '1h', '5m', '1h'].map((ttl, index) => ({
      model: 'requested-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: `turn-${index}`, cache_control: { type: 'ephemeral', ttl } }] }],
      prompt_cache_key: `cache-${index}`,
    }))
    for (const [index, body] of bodies.entries()) {
      const response = await messages(server, body)
      expect(response.status).toBe([429, 503, 500, 200][index])
      await response.text()
    }
    expect(server.requests.map(record => record.body)).toEqual(bodies)
    expect(server.requests.map(record => record.attempt)).toEqual([1, 2, 3, 4])
  })

  it.each(['success', 'empty_body', 'partial_eof', 'rate_limit', 'service_unavailable', 'server_error'] as const)(
    'adds headers without replacing built-in headers for %s', async (behavior) => {
      const server = await start({
        sequence: [behavior], retryAfterMs: 1_001, requestId: 'built-in-id',
        usage: { input_tokens: 19 }, responseModel: 'returned-model',
        responseHeaders: { 'X-Evidence': 'fixed', 'Retry-After': '99', 'X-Request-ID': 'extra-id', 'Content-Type': 'text/plain' },
      })
      const response = await messages(server)
      expect(response.headers.get('x-evidence')).toBe('fixed')
      expect(response.headers.get('retry-after')).toBe(behavior === 'rate_limit' ? '2' : '99')
      const isError = ['rate_limit', 'service_unavailable', 'server_error'].includes(behavior)
      expect(response.headers.get('content-type')).toBe(isError ? 'application/json' : 'text/event-stream; charset=utf-8')
      expect(response.headers.get('x-request-id')).toBe(isError ? 'built-in-id' : 'extra-id')
      await response.text()
    },
  )

  it('copies evidence options when the server starts', async () => {
    const usage = { input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 8 } }
    const responseHeaders = { 'x-evidence': 'original' }
    const server = await start({ usage, responseHeaders })
    usage.input_tokens = 99
    usage.cache_creation.ephemeral_5m_input_tokens = 99
    responseHeaders['x-evidence'] = 'changed'
    const response = await messages(server)
    expect(response.headers.get('x-evidence')).toBe('original')
    expect(events(await response.text())[0]?.message).toMatchObject({
      usage: { input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 8 } },
    })
  })

  it.each(['/v1/chat/completions', '/v1/responses'])('captures the supported %s protocol with evidence', async (path) => {
    const server = await start({ usage: { input_tokens: 12 }, responseModel: 'returned-model' })
    const response = await fetch(`${server.baseURL}${path}`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(server.requests).toEqual([expect.objectContaining({ path, body: {}, attempt: 1 })])
    const wire = await response.text()
    expect(wire).toContain('returned-model')
    expect(wire).toContain(path.endsWith('/responses') ? '"input_tokens":12' : '"prompt_tokens":12')
  })

  it.each([
    { usage: { input_tokens: -1 } },
    { usage: { output_tokens: 0.5 } },
    { usage: { cache_read_input_tokens: Number.NaN } },
    { usage: { cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { cache_creation: { ephemeral_5m_input_tokens: -1 } } },
    { usage: { cache_creation: { ephemeral_1h_input_tokens: Number.POSITIVE_INFINITY } } },
    { responseModel: '' },
    { responseHeaders: { 'bad header': 'value' } },
    { responseHeaders: { 'x-evidence': 'bad\r\nvalue' } },
  ])('rejects invalid evidence options before listening %#', async (options) => {
    await expect(start(options)).rejects.toThrow()
  })

  it.each(['partial_disconnect', 'connection_reset', 'stream_disconnect'] satisfies MockLlmBehavior[])(
    'keeps %s transport failures with evidence configured', async (behavior) => {
      const server = await start({ sequence: [behavior], usage: { input_tokens: 7 }, responseModel: null, responseHeaders: { 'x-evidence': 'fixed' }, chunkDelayMs: 0 })
      await expect((async () => { await (await messages(server)).text() })()).rejects.toThrow()
      expect(server.requests[0]?.outcome).toBe('reset')
    },
  )

  it('retains stall, repeat-last, and sequence exhaustion with evidence configured', async () => {
    const server = await start({ sequence: ['stall'], responseHeaders: { 'x-evidence': 'fixed' } })
    const controller = new AbortController()
    const response = await fetch(`${server.baseURL}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal })
    expect(response.headers.get('x-evidence')).toBe('fixed')
    expect(server.requests[0]?.outcome).toBe('stalled')
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    const exhausted = await messages(server)
    expect(exhausted.status).toBe(500)
    expect(exhausted.headers.get('x-evidence')).toBe('fixed')
    await exhausted.text()
    const repeating = await start({ sequence: ['empty'], repeatLast: true, usage: { input_tokens: 4 } })
    for (let index = 0; index < 2; index += 1) {
      expect(events(await (await messages(repeating)).text())[0]?.message).toMatchObject({ usage: { input_tokens: 4 } })
    }
  })

  it('passes CLI evidence options through to the server', async () => {
    const parsed = parseMockLlmCliArgs([
      '--sequence', 'empty', '--port', '0', '--usage', '{"input_tokens":12,"output_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":6}}',
      '--response-model', 'returned-model', '--response-headers', '{"x-evidence":"cli"}',
    ])
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') throw new Error('expected run configuration')
    const server = await start(parsed.config.server)
    const response = await messages(server)
    expect(response.headers.get('x-evidence')).toBe('cli')
    expect(events(await response.text())[0]?.message).toMatchObject({ model: 'returned-model', usage: { input_tokens: 12, cache_creation: { ephemeral_1h_input_tokens: 6 } } })
    expect(parseMockLlmCliArgs(['--sequence', 'empty', '--omit-response-model'])).toMatchObject({ config: { server: { responseModel: null } } })
  })

  it.each([
    ['--usage', 'null'], ['--usage', '[]'], ['--usage', '{'], ['--usage', '{"prompt_tokens":1}'],
    ['--usage', '{"input_tokens":"1"}'], ['--usage', '{"output_tokens":-1}'],
    ['--usage', '{"cache_creation":null}'], ['--usage', '{"cache_creation":{"unknown":1}}'],
    ['--usage', '{"cache_creation":{"ephemeral_5m_input_tokens":0.5}}'],
    ['--response-headers', '[]'], ['--response-headers', '{"x-evidence":3}'],
    ['--response-model', 'model', '--omit-response-model'],
  ])('rejects invalid CLI evidence options %#', (...argv) => {
    expect(() => parseMockLlmCliArgs(['--sequence', 'success', ...argv])).toThrow()
  })
})
