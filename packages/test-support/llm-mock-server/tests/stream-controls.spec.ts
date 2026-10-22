import { afterEach, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '../src/index.ts'

const servers: MockLlmServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

async function start(options: Parameters<typeof startMockLlmServer>[0]) {
  const server = await startMockLlmServer(options)
  servers.push(server)
  return server
}

async function send(server: MockLlmServer, body: object, signal?: AbortSignal, path = '/v1/messages') {
  return fetch(`${server.baseURL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
}

describe('stream checkpoints and actual request identity evidence', () => {
  it.each(['/v1/messages', '/v1/responses', '/v1/chat/completions'])('captures explicit wire user ids at %s without counting assistant ids', async (path) => {
    const server = await start({ sequence: ['success'], successText: 'Already read', chunkSize: 100 })
    const items = [{ role: 'user', id: 'message-a', content: 'hello' }, { role: 'assistant', id: 'not-user', content: 'reply' }, { role: 'user', message_id: 'message-a', content: 'repeat' }]
    const response = await send(server, path === '/v1/responses' ? { input: items } : { messages: items }, undefined, path)
    expect(await response.text()).toContain('Already read')
    expect(server.requests[0]?.userMessageIds).toEqual(['message-a'])
    expect(server.requests[0]?.signal.aborted).toBe(false)
  })

  it('marks absent identities unavailable instead of inventing request membership', async () => {
    const server = await start({ sequence: ['success', 'success', 'success'] })
    await (await send(server, { messages: [{ role: 'user', content: 'no id' }] })).text()
    await (await send(server, {})).text()
    await (await send(server, { messages: [] })).text()
    expect(server.requests.map(record => record.userMessageIds)).toEqual([null, null, []])
  })

  it('copies caller-provided extraction from the actual request and keeps per-request evidence separate', async () => {
    const extracted = ['message-a']
    let observed: unknown
    const server = await start({
      sequence: ['success'],
      captureUserMessageIds(body) { observed = body; return extracted },
    })
    const body = { messages: [{ role: 'user', content: '[message-a] text' }] }
    await (await send(server, body)).text()
    extracted.push('not-sent')
    expect(observed).toEqual(body)
    expect(server.requests[0]?.userMessageIds).toEqual(['message-a'])
    expect(Object.isFrozen(server.requests[0]?.userMessageIds)).toBe(true)
  })

  it.each(['/v1/messages', '/v1/responses', '/v1/chat/completions'])('waits at an explicit chunk checkpoint and confirms actual transport cancellation at %s', async (path) => {
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const server = await start({
      sequence: ['success'], successText: 'Already read', chunkSize: 1,
      async beforeChunk(record) {
        reached.resolve(undefined)
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => { record.signal.addEventListener('abort', () => { resolve() }, { once: true }) }),
        ])
      },
    })
    const controller = new AbortController()
    const response = await send(server, { messages: [{ role: 'user', id: 'message-a', content: 'hello' }] }, controller.signal, path)
    try {
      await reached.promise
      const record = server.requests[0]
      if (record === undefined) throw new Error('missing request')
      const beforeAbort = record.chunksSent
      controller.abort()
      await record.abortConfirmed
      expect(record.signal.aborted).toBe(true)
      await expect(response.text()).rejects.toThrow()
      release.resolve(undefined)
      await Promise.resolve()
      expect(record.chunksSent).toBe(beforeAbort)
      expect(record.outcome).toBe('client_closed')
    } finally {
      release.resolve(undefined)
    }
  })

  it('confirms abort even for a stalled request with an existing outcome', async () => {
    const server = await start({ sequence: ['stall'] })
    const controller = new AbortController()
    const response = await send(server, {}, controller.signal)
    const record = server.requests[0]
    if (record === undefined) throw new Error('missing request')
    expect(record.outcome).toBe('stalled')
    controller.abort()
    await record.abortConfirmed
    expect(record.signal.aborted).toBe(true)
    expect(record.outcome).toBe('stalled')
    await expect(response.text()).rejects.toThrow()
  })
})
