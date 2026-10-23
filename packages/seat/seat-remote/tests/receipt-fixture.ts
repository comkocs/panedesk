/** Real Loader ingress and engine journal with an ephemeral HTTP receipt destination. */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import type { Context } from '@panedesk/cordis'
import type { CredentialProvider } from '@panedesk/dsh-credentials'
import type { WebRoute, WebServer } from '@panedesk/dsh-host-webserver'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import type { SeatCallbackPayload, SeatTriggerSource } from '@panedesk/dsh-seat'
import { composition } from '../../seat-engine/tests/composition-fixture.ts'
import { auto } from '../../seat-engine/tests/fixtures.ts'
import { registerWebhook, type WebhookSource } from '../src/webhook.ts'

interface Receipt { body: string; headers: IncomingHttpHeaders }

/** Own receipt listeners and Loader services until teardown completes.
 * @param options - receipt registration and engine timeout for the scenario.
 * @returns ingress, receiver observations, durable outcomes and awaited cleanup.
 */
export async function receiptFixture(options: { callback?: boolean; timeoutMs?: number } = {}) {
  const secret = randomBytes(32).toString('hex'), receipts: Receipt[] = []
  const unique = new Map<string, string>(), routes = new Map<string, WebRoute>()
  const state = { status: 204, stall: false, oversized: false, redirected: 0, credentialFailure: false }
  const receiver = createServer((req, res) => {
    if (req.url !== '/receipt') { state.redirected++; res.end(); return }
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => { parts.push(part) })
    req.on('end', () => {
      const receipt = { body: Buffer.concat(parts).toString('utf8'), headers: req.headers }
      receipts.push(receipt)
      const key = req.headers['idempotency-key']
      if (typeof key === 'string') unique.set(key, receipt.body)
      if (state.stall) return
      res.writeHead(state.status, { location: '/redirected' })
      res.end(state.oversized ? 'x'.repeat(1001) : undefined)
    })
  })
  receiver.listen(0, 'localhost')
  await once(receiver, 'listening')
  const address = receiver.address()
  if (!address || typeof address === 'string') throw new Error('Missing receipt listener')
  const url = `http://localhost:${address.port}/receipt`
  const source: WebhookSource = { sourceId: 'external-source' as never, seat: 'seat-a' as never,
    projectId: 'project-a' as never, credentialRefs: { current: 'TEST_SOURCE_KEY' },
    ...(options.callback === false ? {} : { callback: { url, keyVersion: 'current' } }) }
  const transport = { apply(ctx: Context) {
    const credentials: Pick<CredentialProvider, 'resolve'> = { resolve: async () => {
      if (state.credentialFailure) throw new Error(`${secret} ${url}`)
      return { value: secret, source: 'test' }
    } }
    ctx.provide('credentials', credentials as CredentialProvider)
    ctx.provide('webServer', { register(route: WebRoute) {
      routes.set(route.path, route); return () => { routes.delete(route.path) }
    } } as WebServer)
  } }
  let registered: SeatTriggerSource | undefined
  const ingress = { apply(ctx: Context) {
    registerWebhook(ctx, { path: '/seat-events', maxBodyBytes: 1024, maxClockSkewMs: 5000, bodyTimeoutMs: 1000,
      sources: [source], audit: async (fact) => {
        const engine = ctx.get('seatEngine')
        if (!engine) throw new Error('Missing audit engine')
        await engine.auditSourceRejection(fact)
      } })
  } }
  const closeReceiver = async () => {
    const closed = new Promise<void>((resolve, reject) => { receiver.close((error) => { if (error) reject(error); else resolve() }) })
    receiver.closeAllConnections()
    await closed
  }
  let f: Awaited<ReturnType<typeof composition>> | undefined
  try {
    f = await composition(false, { builtins: { transport, ingress }, entries: [{ name: 'cordis:transport' }] })
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.options.config.callbackTimeoutMs = options.timeoutMs ?? 1000
    const register = engine.registerSource.bind(engine)
    engine.registerSource = (value) => { registered = value; return register(value) }
    const fiber = await f.ctx.loader.create({ name: 'cordis:ingress' })
    await f.ctx.loader.await()
    const ctx = f.ctx
    engine.registerExecutor({ observe: async open => ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async open => (await ctx.agents.create({ sessionId: open.sessionId,
        agentOptions: { provider: 'mock', model: 'model-a' } })).agent.id,
      configure: async () => {}, opening: async () => ({ messageId: 'opening-a' as never, state: 'completed' }),
      owner: async () => 'alive', wakeSender: async () => 'unavailable' })
    await auto(engine)
    const send = async () => {
      const timestamp = String(Date.now()), body = JSON.stringify({ eventId: 'event-a', eventType: 'open', data: null })
      const server = createServer((req, res) => { void routes.get('/seat-events')?.handler(req, res) })
      server.listen(0, 'localhost')
      await once(server, 'listening')
      const local = server.address()
      if (!local || typeof local === 'string') throw new Error('Missing ingress listener')
      try {
        const response = await fetch(`http://localhost:${local.port}/seat-events`, { method: 'POST', headers: {
          'content-type': 'application/json', 'x-seat-source': source.sourceId, 'x-seat-timestamp': timestamp,
          'x-seat-key-version': 'current', 'x-seat-signature': createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex'),
        }, body })
        await response.arrayBuffer()
        return response.status
      } finally {
        const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed
      }
    }
    return { engine, ctx, receipts, unique, source, state, secret, url, send,
      delivery: () => [...engine.journal.projection.callbacks.values()][0],
      callback: async (payload: SeatCallbackPayload) => { if (!registered) throw new Error('Missing source'); await registered.callback(payload) },
      async unload() { await ctx.loader.resolve(fiber).fiber?.dispose() },
      async close() { try { await f?.close() } finally { await closeReceiver() } },
    }
  } catch (error) {
    try { await f?.close() } finally { await closeReceiver() }
    throw error
  }
}
