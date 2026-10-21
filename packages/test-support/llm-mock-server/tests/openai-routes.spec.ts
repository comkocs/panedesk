import { afterEach, describe, expect, it } from 'vitest'
import type { MockLlmBehavior, MockLlmServer, MockLlmServerOptions } from '../src/index.ts'
import { startMockLlmServer } from '../src/index.ts'

const running: MockLlmServer[] = []
const routes = [
  { path: '/v1/responses', protocol: 'responses', input: 'input_tokens', output: 'output_tokens', details: 'input_tokens_details' },
  { path: '/v1/chat/completions', protocol: 'chat_completions', input: 'prompt_tokens', output: 'completion_tokens', details: 'prompt_tokens_details' },
] as const

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

async function start(options: Partial<MockLlmServerOptions> = {}): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence: ['success'], chunkSize: 100, chunkDelayMs: 0, successText: 'answer', ...options })
  running.push(server)
  return server
}

function post(server: MockLlmServer, path: string, body: object = { model: 'requested-model', stream: true }): Promise<Response> {
  return fetch(`${server.baseURL}${path}`, { method: 'POST', body: JSON.stringify(body) })
}

function events(wire: string): Array<Record<string, unknown>> {
  return wire.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

function terminal(wire: string, protocol: string): Record<string, unknown> {
  const last = events(wire).at(-1)!
  return protocol === 'responses' ? last.response as Record<string, unknown> : last
}

describe.each(routes)('OpenAI $protocol route', (route) => {
  it('maps all shared usage counters to wire fields and reports only total cache writes', async () => {
    const server = await start({ usage: {
      input_tokens: 101, output_tokens: 17, cache_read_input_tokens: 40, cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    } })
    const wire = await (await post(server, route.path)).text()
    expect(terminal(wire, route.protocol).usage).toEqual({
      [route.input]: 101, [route.output]: 17, total_tokens: 118,
      [route.details]: { cached_tokens: 40, cache_write_tokens: 30 },
    })
    expect(wire).not.toContain('ephemeral_')
    expect(server.requests[0]).toMatchObject({ protocol: route.protocol, path: route.path, outcome: 'completed' })
  })

  it.each(['requested-model', 'returned-model', null])('returns model %s without changing the captured request', async (responseModel) => {
    const server = await start({ responseModel })
    const wire = await (await post(server, route.path)).text()
    const payloads = events(wire).map(value => route.protocol === 'responses' && 'response' in value ? value.response as Record<string, unknown> : value)
    if (responseModel === null) {
      expect(wire).not.toContain('"model"')
    } else {
      expect(terminal(wire, route.protocol).model).toBe(responseModel)
      expect(payloads.filter(value => 'model' in value).length).toBeGreaterThan(0)
      expect(payloads.filter(value => 'model' in value).every(value => value.model === responseModel)).toBe(true)
    }
    expect(server.requests[0]?.body).toEqual({ model: 'requested-model', stream: true })
  })

  it('captures cache key, ttl, and mode exactly through a gateway prefix', async () => {
    const server = await start({ repeatLast: true })
    const ttls = route.protocol === 'responses' ? ['30m', '12h'] : ['30m']
    const bodies = ttls.map(ttl => ({ model: 'requested-model', prompt_cache_key: 'cache-key', prompt_cache_options: { ttl, mode: 'read_write' }, stream: true }))
    for (const body of bodies) await (await post(server, `/gateway${route.path}`, body)).text()
    expect(server.requests.map(record => record.body)).toEqual(bodies)
    expect(server.requests.map(record => record.protocol)).toEqual(bodies.map(() => route.protocol))
  })

  it('keeps omitted counters absent, explicit zero counters, and deterministic default bytes', async () => {
    const server = await start({ repeatLast: true })
    const first = await (await post(server, route.path)).text()
    expect(Buffer.from(await (await post(server, route.path)).text())).toEqual(Buffer.from(first))
    expect(terminal(first, route.protocol)).toMatchObject({ model: 'mock-model', usage: { [route.input]: 3, [route.output]: 6, total_tokens: 9 } })
    expect(terminal(first, route.protocol).usage).not.toHaveProperty(route.details)
    const zero = await start({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(terminal(await (await post(zero, route.path)).text(), route.protocol).usage).toEqual({
      [route.input]: 0, [route.output]: 0, total_tokens: 0, [route.details]: { cached_tokens: 0, cache_write_tokens: 0 },
    })
  })

  it.each([
    ['rate_limit', 429], ['service_unavailable', 503], ['server_error', 500],
    ['auth_error', 401], ['invalid_request', 400], ['context_overflow', 400], ['quota_exceeded', 429],
  ] as const)('preserves %s errors and subsequent success', async (behavior, status) => {
    const server = await start({ sequence: [behavior, 'success'], retryAfterMs: 1_001, responseHeaders: { 'x-evidence': 'fixed' } })
    const failure = await post(server, route.path)
    expect(failure.status).toBe(status)
    expect(failure.headers.get('x-evidence')).toBe('fixed')
    if (behavior === 'rate_limit') expect(failure.headers.get('retry-after')).toBe('2')
    expect(await failure.json()).toHaveProperty('error')
    const success = await post(server, route.path)
    expect(success.status).toBe(200)
    expect(terminal(await success.text(), route.protocol).usage).toMatchObject({ [route.input]: 3 })
    expect(server.requests.map(record => record.behavior)).toEqual([behavior, 'success'])
  })

  it.each(['connection_reset', 'stream_disconnect', 'partial_disconnect'] as const)('preserves %s transport failure', async (behavior) => {
    const server = await start({ sequence: [behavior] })
    await expect((async () => { await (await post(server, route.path)).text() })()).rejects.toThrow()
    expect(server.requests[0]).toMatchObject({ protocol: route.protocol, behavior, outcome: 'reset' })
  })

  it('keeps stall cancellable and sequence exhaustion explicit', async () => {
    const server = await start({ sequence: ['stall'], responseHeaders: { 'x-evidence': 'fixed' } })
    const controller = new AbortController()
    const response = await fetch(`${server.baseURL}${route.path}`, { method: 'POST', body: '{}', signal: controller.signal })
    expect(response.headers.get('x-evidence')).toBe('fixed')
    expect(server.requests[0]?.outcome).toBe('stalled')
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    const exhausted = await post(server, route.path)
    expect(exhausted.status).toBe(500)
    expect(await exhausted.json()).toMatchObject({ error: { code: 'MOCK_SCRIPT_EXHAUSTED' } })
  })

  it.each(['empty_body', 'stream_eof', 'partial_eof'] as const)('does not accidentally complete %s', async (behavior) => {
    const server = await start({ sequence: [behavior] })
    const wire = await (await post(server, route.path)).text()
    expect(wire).not.toContain('[DONE]')
    expect(wire).not.toContain('response.completed')
    expect(wire).not.toContain('"finish_reason":"stop"')
    if (behavior === 'empty_body') expect(wire).toBe('')
    if (behavior === 'partial_eof') expect(wire).toContain('discarded partial response')
  })

  it.each(['success', 'slow_success', 'reasoning_success', 'tool_call_success', 'max_tokens', 'empty', 'wrong_content_type'] as const)(
    'completes %s with usage and protocol-specific termination', async (behavior) => {
      const server = await start({ sequence: [behavior], usage: { output_tokens: 37 } })
      const response = await post(server, route.path)
      expect(response.headers.get('content-type')).toBe(behavior === 'wrong_content_type' ? 'application/json' : 'text/event-stream; charset=utf-8')
      const wire = await response.text()
      expect(terminal(wire, route.protocol).usage).toMatchObject({ [route.output]: 37 })
      if (route.protocol === 'responses') {
        expect(wire).toContain(behavior === 'max_tokens' ? 'event: response.incomplete\n' : 'event: response.completed\n')
        expect(terminal(wire, route.protocol).status).toBe(behavior === 'max_tokens' ? 'incomplete' : 'completed')
        if (behavior === 'tool_call_success') expect(wire).toContain('response.function_call_arguments.delta')
        if (behavior === 'reasoning_success') expect(wire).toContain('response.reasoning_summary_text.delta')
      } else {
        expect(wire.endsWith('data: [DONE]\n\n')).toBe(true)
        expect(wire).not.toContain('event:')
        expect(wire).toContain(`"finish_reason":"${behavior === 'max_tokens' ? 'length' : behavior === 'tool_call_success' ? 'tool_calls' : 'stop'}"`)
      }
    },
  )

  it.each(['malformed_json', 'malformed_event'] satisfies MockLlmBehavior[])('retains %s protocol faults', async (behavior) => {
    const server = await start({ sequence: [behavior] })
    const wire = await (await post(server, route.path)).text()
    if (behavior === 'malformed_json') expect(wire).toBe('data: {not-json\n\n')
    else expect(wire).toContain(route.protocol === 'responses' ? '"item":null' : '"content":1')
    expect(wire).not.toContain('response.completed')
    expect(wire).not.toContain('[DONE]')
  })

  it('uses Bearer authentication and rejects invalid JSON without consuming the script', async () => {
    const server = await start({ apiKey: 'test-key' })
    const denied = await post(server, route.path)
    expect(denied.status).toBe(401)
    await denied.text()
    const headers = { authorization: 'Bearer test-key' }
    const invalid = await fetch(`${server.baseURL}${route.path}`, { method: 'POST', headers, body: '{' })
    expect(invalid.status).toBe(400)
    await invalid.text()
    expect(server.requests).toEqual([])
    const valid = await fetch(`${server.baseURL}${route.path}`, { method: 'POST', headers, body: '{}' })
    expect(valid.status).toBe(200)
    await valid.text()
    expect(server.requests).toHaveLength(1)
  })
})

it('shares one FIFO across Messages, Responses, and Chat Completions', async () => {
  const server = await start({ sequence: ['rate_limit', 'service_unavailable', 'server_error', 'success', 'empty', 'max_tokens'] })
  const paths = ['/v1/messages', '/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/chat/completions']
  for (const [index, path] of paths.entries()) {
    const response = await post(server, path)
    expect(response.status).toBe([429, 503, 500, 200, 200, 200][index])
    await response.text()
  }
  expect(server.requests.map(record => record.attempt)).toEqual([1, 2, 3, 4, 5, 6])
  expect(server.requests.map(record => record.protocol)).toEqual(['messages', 'responses', 'chat_completions', 'messages', 'responses', 'chat_completions'])
  expect(server.requests.map(record => record.behavior)).toEqual(['rate_limit', 'service_unavailable', 'server_error', 'success', 'empty', 'max_tokens'])
})

it('emits the Responses text lifecycle with indexed deltas and terminal evidence', async () => {
  const server = await start({ chunkSize: 3 })
  const wire = await (await post(server, '/v1/responses')).text()
  const payloads = events(wire)
  expect(payloads.map(value => value.type)).toEqual([
    'response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_item.done', 'response.completed',
  ])
  expect(payloads.map(value => value.sequence_number)).toEqual([0, 1, 2, 3, 4, 5])
  expect(payloads[2]).toMatchObject({ output_index: 0, item_id: 'mock-message', content_index: 0, delta: 'ans' })
  expect(payloads[3]).toMatchObject({ delta: 'wer' })
  expect(payloads[4]).toMatchObject({ output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'answer' }] } })
})
