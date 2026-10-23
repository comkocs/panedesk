import { createHmac, randomBytes } from 'node:crypto'
import { Socket } from 'node:net'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@panedesk/dsh-credentials'
import type { SeatEngineService, TriggerEnvelope, AcceptTriggerResult } from '@panedesk/dsh-seat'
import type { WebServer, WebRoute } from '@panedesk/dsh-host-webserver'
import { handleWebhook, registerWebhook, type WebhookOptions } from '../src/webhook.ts'

function fixture() {
  const ctx = new Context(), secret = randomBytes(32).toString('hex')
  const accept = vi.fn(async (_request: TriggerEnvelope): Promise<AcceptTriggerResult> => ({ status: 'accepted', triggerId: 'trigger-a' as never, queueItemId: 'queue-a' as never, sequence: 1 }))
  const resolve = vi.fn(async () => ({ value: secret, source: 'test' }))
  ctx.provide('credentials', { resolve } as Partial<CredentialProvider> as CredentialProvider)
  ctx.provide('seatEngine', { accept, registerSource: () => async () => {} } as Partial<SeatEngineService> as SeatEngineService)
  const options: WebhookOptions = { path: '/seat-events', maxBodyBytes: 1024, maxClockSkewMs: 5000, bodyTimeoutMs: 1000,
    sources: [{ sourceId: 'source-a' as never, seat: 'seat-a' as never, projectId: 'project-a' as never, credentialRefs: { current: 'TEST_SOURCE_KEY' } }], audit: vi.fn(async () => {}) }
  const send = async (body: string, headers: Record<string, string> = {}) => {
    const timestamp = String(Date.now())
    const req = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat-source': 'source-a',
      'x-seat-timestamp': timestamp, 'x-seat-key-version': 'current', 'x-seat-signature': createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex'), ...headers } })
    let status = 0, output = ''
    const res = { get headersSent() { return status !== 0 }, writeHead(code: number) { status = code }, end(value?: string) { output += value ?? '' } } as Partial<ServerResponse> as ServerResponse
    req.push(Buffer.from(body)); req.push(null)
    try { await handleWebhook(ctx, options, req, res); return { status, output } }
    finally { req.destroy(); req.socket.destroy() }
  }
  return { ctx, secret, options, send, accept, resolve }
}

describe('external seat source authentication', () => {
  it('accepts untouched signed bytes only after durable ingress resolves', async () => {
    const f = fixture()
    try {
      const barrier = Promise.withResolvers<undefined>()
      const entered = Promise.withResolvers<undefined>()
      f.accept.mockImplementationOnce(async () => { entered.resolve(undefined); await barrier.promise; return { status: 'accepted', triggerId: 'trigger-a' as never, queueItemId: 'queue-a' as never, sequence: 1 } })
      let finished = false
      const response = f.send('{ "eventId": "event-a", "eventType": "open", "data": {"seat":"seat-b"} }').then((result) => { finished = true; return result })
      await entered.promise
      expect(f.accept).toHaveBeenCalledTimes(1)
      expect(finished).toBe(false)
      expect(f.accept.mock.calls[0]?.[0]).toMatchObject({ seat: 'seat-a', projectId: 'project-a', sourceId: 'source-a', eventId: 'event-a', kind: 'external' })
      barrier.resolve(undefined)
      expect((await response).status).toBe(202)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('rejects wrong signatures and durably audits only sanitized facts', async () => {
    const f = fixture()
    try {
      const body = JSON.stringify({ eventId: 'event-a', eventType: 'open' })
      const response = await f.send(body, { 'x-seat-signature': '0'.repeat(64) })
      expect(response.status).toBe(401); expect(f.accept).not.toHaveBeenCalled()
      const fact = vi.mocked(f.options.audit).mock.calls[0]?.[0]
      expect(fact?.sourceId).toBe('source-a')
      expect(fact?.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(Number.isFinite(Date.parse(fact?.observedAt ?? ''))).toBe(true)
      expect(fact?.error.code).toBe('source-authentication-failed')
      const audit = JSON.stringify(vi.mocked(f.options.audit).mock.calls)
      expect(audit).not.toContain(f.secret); expect(audit).not.toContain(body); expect(audit).not.toContain('0'.repeat(64))
    } finally { await f.ctx.fiber.dispose() }
  })
  it('fails closed for stale timestamps, unknown keys, oversized bodies and storage loss', async () => {
    const f = fixture()
    try {
      const body = JSON.stringify({ eventId: 'event-a', eventType: 'open' })
      expect((await f.send(body, { 'x-seat-timestamp': '0' })).status).toBe(401)
      expect((await f.send(body, { 'x-seat-key-version': 'retired' })).status).toBe(401)
      expect((await f.send('x'.repeat(1025))).status).toBe(413)
      f.accept.mockRejectedValueOnce(new Error('private provider detail'))
      expect(await f.send(body)).toEqual({ status: 503, output: '{"code":"unavailable"}' })
      expect(f.accept).toHaveBeenCalledTimes(1)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('audits unknown sources, oversized prefixes and malformed signed bodies before refusal', async () => {
    const f = fixture()
    try {
      expect((await f.send('{"eventType":"open"}', { 'x-seat-source': 'source-b' })).status).toBe(401)
      expect((await f.send('x'.repeat(1025))).status).toBe(413)
      expect((await f.send('{')).status).toBe(400)
      expect((await f.send('{"eventType":"open","data":1e999}')).status).toBe(400)
      expect(vi.mocked(f.options.audit).mock.calls.map(([fact]) => fact.error.code))
        .toEqual(['source-authentication-failed', 'source-payload-too-large', 'invalid-request', 'invalid-request'])
      expect(vi.mocked(f.options.audit).mock.calls[0]?.[0].sourceId).toBe('unregistered-source')
      expect(f.accept).not.toHaveBeenCalled()
      vi.mocked(f.options.audit).mockRejectedValueOnce(new Error('storage unavailable'))
      expect((await f.send('{}', { 'x-seat-source': 'source-b' })).status).toBe(503)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('admits event-less signed input for engine-owned time-bucket deduplication', async () => {
    const f = fixture()
    try {
      expect((await f.send('{"eventType":"open"}')).status).toBe(202)
      expect(f.accept.mock.calls[0]?.[0]).not.toHaveProperty('eventId')
    } finally { await f.ctx.fiber.dispose() }
  })
  it('bounds stalled body reads and removes every read listener', async () => {
    const f = fixture()
    const req = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat-source': 'source-a' } })
    const writeHead = vi.fn(), end = vi.fn()
    const res = { headersSent: false, writeHead, end } as Partial<ServerResponse> as ServerResponse
    vi.useFakeTimers()
    try {
      const task = handleWebhook(f.ctx, f.options, req, res)
      await vi.advanceTimersByTimeAsync(f.options.bodyTimeoutMs)
      await task
      expect(writeHead).toHaveBeenCalledWith(408, { 'content-type': 'application/json' })
      expect(req.listenerCount('data')).toBe(0)
      expect(req.listenerCount('end')).toBe(0)
      expect(req.listenerCount('error')).toBe(0)
      expect(f.accept).not.toHaveBeenCalled()
      expect(vi.mocked(f.options.audit).mock.calls[0]?.[0].error.code).toBe('invalid-request')
    } finally { vi.useRealTimers(); req.destroy(); req.socket.destroy(); await f.ctx.fiber.dispose() }
  })
  it('cancels unaccepted body reads on unload and awaits their audit settlement', async () => {
    const f = fixture(), routes = new Map<string, WebRoute>()
    f.ctx.provide('webServer', { register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path) } } } as WebServer)
    registerWebhook(f.ctx, f.options)
    const route = routes.get('/seat-events')
    if (!route) throw new Error('Missing route')
    const req = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat-source': 'source-a' } })
    const writeHead = vi.fn(), end = vi.fn()
    const res = { headersSent: false, writeHead, end } as Partial<ServerResponse> as ServerResponse
    const audit = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    vi.mocked(f.options.audit).mockImplementationOnce(() => { entered.resolve(undefined); return audit.promise })
    try {
      const task = route.handler(req, res)
      let disposed = false
      const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
      await entered.promise
      expect(f.options.audit).toHaveBeenCalledTimes(1)
      expect(routes.size).toBe(0)
      expect(disposed).toBe(false)
      audit.resolve(undefined)
      await Promise.all([task, disposal])
      expect(writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' })
      expect(f.accept).not.toHaveBeenCalled()
      expect(req.listenerCount('data')).toBe(0)
    } finally { audit.resolve(undefined); req.destroy(); req.socket.destroy(); await f.ctx.fiber.dispose() }
  })
  it('removes the route and waits for owned work during disposal', async () => {
    const f = fixture(), routes = new Map<string, WebRoute>()
    f.ctx.provide('webServer', { register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path) } } } as WebServer)
    registerWebhook(f.ctx, f.options)
    expect(routes.has('/seat-events')).toBe(true)
    await f.ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })
})
