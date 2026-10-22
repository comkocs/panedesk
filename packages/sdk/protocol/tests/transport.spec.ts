import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcLineTransport, JsonRpcResponseError, decodeMessagesRequest, decodeMessagesResult, decodeMessageState, isMessagesMethod } from '../src/index.ts'

function transportPair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcLineTransport(bToA, aToB)
  const b = new JsonRpcLineTransport(aToB, bToA)
  return { a, b, aToB, bToA }
}

describe('Message wire validation', () => {
  const controls = { messageId: 'message-a', operationId: 'operation-a', expectedRevision: 0 }
  const cases = [
    ['messages/send', { target: { sessionId: 'seat-a' }, content: 'work', messageClass: 'handoff', operationId: 'operation-a' }, { messageId: 'message-a', operationId: 'operation-a', deliveryOutcome: 'rejected', reason: 'target-not-found', messageState: 'rejected', pending: false, candidates: [] }],
    ['messages/withdraw', controls, { ...controls, kind: 'accepted-pending-owner', state: 'queued', revision: 0 }],
    ['messages/edit', { ...controls, content: 'updated' }, { ...controls, kind: 'rejected', reason: 'claimed', status: null }],
    ['messages/reprioritize', { ...controls, priority: 'immediate' }, { ...controls, kind: 'rejected', reason: 'injected', status: null }],
    ['messages/invalidate', { ...controls, reason: 'superseded' }, { ...controls, kind: 'accepted-pending-owner', state: 'queued', revision: 0 }],
    ['messages/status', { messageId: 'message-a' }, { messageId: 'message-a', state: 'queued', phase: 'pending', revision: 0, stateVersion: 1, transitions: [] }],
    ['messages/operationStatus', { operationId: 'operation-a' }, { operationId: 'operation-a', kind: 'not-found' }],
    ['messages/list', {}, { items: [], complete: false, nextCursor: 'cursor-a' }],
    ['messages/resolve', { addresses: [{ name: 'seat-a' }] }, []],
    ['messages/sendBatch', { messageClass: 'reply', replyTo: 'message-a', content: 'reply', recipients: [], dryRun: true }, { kind: 'resolved', recipients: [] }],
    ['messages/configure', { sessionId: 'seat-a', settings: { receiveMode: 'none', wakeOnHandoff: false } }, { receiveMode: 'none', wakeOnHandoff: false }],
    ['messages/subscribe', { sessionId: 'seat-a', cursor: 'cursor-a' }, { cursor: 'cursor-a' }],
  ] as const
  it.each(cases)('round trips %s and retains structured refusal', async (method, params, result) => {
    expect(isMessagesMethod(method)).toBe(true)
    expect(decodeMessagesRequest(method, params)).toEqual(params)
    expect(decodeMessagesResult(method, result)).toEqual(result)
    expect(() => decodeMessagesRequest(method, null)).toThrow()
    expect(() => decodeMessagesResult(method, null)).toThrow()
    const { a, b } = transportPair()
    a.onRequest(async (name, value) => {
      expect(name).toBe(method)
      expect(decodeMessagesRequest(method, value)).toEqual(params)
      return result
    })
    a.start(); b.start()
    try {
      expect(decodeMessagesResult(method, await b.request(method, params))).toEqual(result)
      a.onRequest(async () => { throw new JsonRpcResponseError(-32601, 'unsupported', { reason: 'unsupported' }) })
      await expect(b.request(method, params)).rejects.toMatchObject({ code: -32601, data: { reason: 'unsupported' } })
    } finally { a.close(); b.close() }
  })
  it('decodes a rejected status carrying the record-corrupt reason', () => {
    const data = { messageId: 'message-a', senderSessionId: null, targetSessionId: 'seat-a', priority: 'steer',
      messageClass: 'handoff', state: 'rejected', revision: 0, stateVersion: 1, operationId: 'operation-a',
      transition: 'rejected', observedAt: 1, reason: 'record-corrupt' }
    const status = { messageId: 'message-a', state: 'rejected', phase: 'settled', revision: 0, stateVersion: 1,
      transitions: [{ cursor: 'cursor-a', nodeId: 'node-a', data }] }
    expect(decodeMessagesResult('messages/status', status)).toEqual(status)
  })
  it('rejects attribution, invalid enums, incomplete replies and malformed receipts', () => {
    const send = cases[0][1]
    for (const patch of [{ senderSessionId: 'seat-b' }, { sender: {} }, { priority: 'urgent' }, { messageClass: 'reply' }, { target: { sessionId: 'seat-a', name: 'seat-a' } }]) {
      expect(() => decodeMessagesRequest('messages/send', { ...send, ...patch })).toThrow()
    }
    expect(isMessagesMethod('toString')).toBe(false)
    expect(() => decodeMessageState({ cursor: 'cursor-a' })).toThrow()
  })
})

describe('JsonRpcLineTransport', () => {
  it('supports bidirectional requests and notifications over newline-delimited JSON-RPC', async () => {
    const { a, b } = transportPair()
    const notifications: Record<string, unknown>[] = []

    a.onRequest(async (method, params) => {
      expect(method).toBe('echo')
      return { echoed: params }
    })
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    a.start()
    b.start()

    const response = await b.request('echo', { value: 42 })
    expect(response).toEqual({ echoed: { value: 42 } })

    a.notify('session.status', { sessionId: 'main', status: 'idle' })
    a.notify('heartbeat')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notifications).toEqual([
      { method: 'session.status', params: { sessionId: 'main', status: 'idle' } },
      { method: 'heartbeat', params: {} },
    ])

    a.close()
    b.close()
  })

  it('reports JSON-RPC request errors from the remote peer with their wire code', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new Error('handler boom')
    })
    a.start()
    b.start()

    const failure = await b.request('explode', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ message: 'handler boom', code: -32603, data: undefined })

    a.close()
    b.close()
  })

  it('rejects immediately on a pre-aborted signal without registering pending state', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    await expect(b.request('never-sent', {}, controller.signal)).rejects.toThrow('already gone')
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('abandons a pending request on abort, stringifying a non-Error reason', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    const pending = b.request('never-answered', {}, controller.signal)
    controller.abort('plain-string-reason')
    await expect(pending).rejects.toThrow('JSON-RPC request aborted: plain-string-reason')
    // The abandonment removed the pending entry — nothing is retained for a
    // response that may never come.
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('preserves structured error data from an error response frame', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error-data', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 7, message: 'structured', data: { detail: 'x' } } })}\n`)

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: 7, message: 'structured', data: { detail: 'x' } })

    b.close()
  })

  it('stringifies non-Error request handler failures', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw 'string boom'
    })
    a.start()
    b.start()

    await expect(b.request('explode-string', {})).rejects.toThrow('string boom')

    a.close()
    b.close()
  })

  it('reports method-not-found when no request handler is installed', async () => {
    const { a, b } = transportPair()
    a.start()
    b.start()

    await expect(b.request('missing', {})).rejects.toThrow('method not found: missing')

    a.close()
    b.close()
  })

  it('normalizes non-object request params and ignores notifications without a handler', async () => {
    const { aToB, bToA, b } = transportPair()
    const seen: Record<string, unknown>[] = []
    b.onRequest(async (method, params) => {
      seen.push({ method, params })
      return { ok: true }
    })
    b.start()

    aToB.write('{"jsonrpc":"2.0","method":"ignored"}\n')
    aToB.write('{"jsonrpc":"2.0","id":7,"method":"array-params","params":[]}\n')
    const chunk = (await once(bToA, 'data'))[0] as Buffer | string

    expect(seen).toEqual([{ method: 'array-params', params: {} }])
    expect(JSON.parse(String(chunk))).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    b.close()
  })

  it('ignores malformed frames and accepts notifications without params', async () => {
    const { aToB, b } = transportPair()
    const notifications: Record<string, unknown>[] = []
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    b.start()
    b.start()

    aToB.write('not json\n')
    aToB.write('\n')
    aToB.write('null\n')
    aToB.write('{"jsonrpc":"2.0","params":{}}\n')
    aToB.write('{"jsonrpc":"2.0","method":"tick"}\n')
    aToB.emit('data', '{"jsonrpc":"2.0","method":"string-chunk"}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([
      { method: 'tick', params: {} },
      { method: 'string-chunk', params: {} },
    ])
    b.close()
  })

  it('preserves multibyte UTF-8 characters split across Buffer chunks', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: Record<string, unknown>[] = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { text: '你好' } })}\n`)
    const character = Buffer.from('你')
    const characterStart = frame.indexOf(character)
    expect(characterStart).toBeGreaterThanOrEqual(0)
    input.write(frame.subarray(0, characterStart + 1))
    input.write(frame.subarray(characterStart + 1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([{ method: 'message', params: { text: '你好' } }])
    transport.close()
  })

  it('flush waits for all earlier output writes', async () => {
    const events: string[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const label = chunk.length === 0 ? 'barrier' : 'frame'
        events.push(`start:${label}`)
        setTimeout(() => {
          events.push(`finish:${label}`)
          callback()
        }, 5)
      },
    })
    const transport = new JsonRpcLineTransport(new PassThrough(), output)

    transport.notify('tick')
    await transport.flush()

    expect(events).toEqual([
      'start:frame',
      'finish:frame',
      'start:barrier',
      'finish:barrier',
    ])
    transport.close()
  })

  it('reports an output callback failure from flush', async () => {
    const output = {
      write(_chunk: string, callback?: (error?: Error) => void) {
        callback?.(new Error('flush failed'))
        return true
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    await expect(transport.flush()).rejects.toThrow('flush failed')
  })

  it('rejects pending requests when the input closes', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.end()

    await expect(pending).rejects.toThrow('JSON-RPC input closed')
    b.close()
  })

  it('rejects pending requests when the input errors', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.emit('error', new Error('input broke'))

    await expect(pending).rejects.toThrow('input broke')
    b.close()
  })

  it('rejects pending requests when the transport closes', async () => {
    const { b } = transportPair()

    const pending = b.request('never-replies', {})
    b.close()

    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
  })

  it('rejects a request when writing the frame throws', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw new Error('write exploded')
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write exploded')
  })

  it('stringifies non-Error write failures', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw 'write string'
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write string')
  })

  it('uses a fallback message for malformed JSON-RPC error responses', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} })}\n`)

    await expect(pending).rejects.toThrow('JSON-RPC error')
    b.close()
  })

  it('ignores responses that do not match a pending request', async () => {
    const { aToB, b } = transportPair()
    b.start()

    aToB.write('{"jsonrpc":"2.0","id":"unknown","result":{"ignored":true}}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    b.close()
  })
})
