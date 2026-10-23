/** Signed HTTP ingress uses a Loader-owned route and the real engine registry. */
import { createHmac, randomBytes } from 'node:crypto'
import { Socket } from 'node:net'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import type { Context } from '@panedesk/cordis'
import type { CredentialProvider } from '@panedesk/dsh-credentials'
import type { WebRoute, WebServer } from '@panedesk/dsh-host-webserver'
import { composition } from '../../seat-engine/tests/composition-fixture.ts'
import { SeatEngine } from '../../seat-engine/src/engine.ts'
import { registerWebhook } from '../src/webhook.ts'

it('accepts valid signatures into the real queue, audits invalid signatures and unregisters its source', async () => {
  const secret = randomBytes(32)
  const routes = new Map<string, WebRoute>()
  const transport = { apply(ctx: Context) {
    const credentials: Pick<CredentialProvider, 'resolve'> = { resolve: async () => ({ value: secret.toString('hex'), source: 'test' }) }
    ctx.provide('credentials', credentials as CredentialProvider)
    ctx.provide('webServer', { register(route: WebRoute) {
      routes.set(route.path, route); return () => { routes.delete(route.path) }
    } } as WebServer)
  } }
  const ingress = { apply(ctx: Context) {
    registerWebhook(ctx, { path: '/seat-events', maxBodyBytes: 1024, maxClockSkewMs: 5000, bodyTimeoutMs: 1000,
      sources: [{ sourceId: 'external-source' as never, seat: 'seat-a' as never, projectId: 'project-a' as never,
        credentialRefs: { current: 'TEST_SOURCE_KEY' } }], audit: async (fact) => {
        const engine = ctx.get('seatEngine')
        if (!engine) throw new Error('Missing audit engine')
        await engine.auditSourceRejection(fact)
      } })
  } }
  const f = await composition(false, { builtins: { transport, ingress }, entries: [{ name: 'cordis:transport' }] })
  try {
    await expect.poll(() => f.ctx.get('subagentAdmission') !== undefined).toBe(true)
    const fiber = await f.ctx.loader.create({ name: 'cordis:ingress' })
    await f.ctx.loader.await()
    const send = async (valid: boolean) => {
      const body = JSON.stringify({ eventId: 'event-a', eventType: 'open', data: null })
      const timestamp = String(Date.now())
      const req = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', headers: {
        'content-type': 'application/json', 'x-seat-source': 'external-source', 'x-seat-timestamp': timestamp,
        'x-seat-key-version': 'current', 'x-seat-signature': valid
          ? createHmac('sha256', secret.toString('hex')).update(`${timestamp}.`).update(body).digest('hex') : '0'.repeat(64),
      } })
      let status = 0
      const response = { get headersSent() { return status !== 0 }, writeHead(code: number) { status = code }, end() {} } as ServerResponse
      req.push(body); req.push(null)
      try { await routes.get('/seat-events')?.handler(req, response); return status }
      finally { req.destroy(); req.socket.destroy() }
    }
    expect(await send(true)).toBe(202)
    expect((await f.ctx.seatEngine.pending({ limit: 10 })).items).toHaveLength(1)
    expect(await send(false)).toBe(401)
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing engine')
    expect(engine.journal.projection.decisions.flatMap(item => item.effects)
      .filter(effect => effect.kind === 'source/rejected').map(effect => effect.data.error.code)).toEqual(['source-authentication-failed'])
    await f.ctx.loader.resolve(fiber).fiber?.dispose()
    expect(routes.size).toBe(0)
    const original = [...engine.journal.projection.dedup.values()][0]?.trigger
    if (!original) throw new Error('Missing accepted event')
    expect(await engine.accept(original)).toMatchObject({ status: 'rejected', error: { code: 'source-not-found' } })
  } finally { await f.close() }
}, 20000)
