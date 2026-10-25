/** Loader activation installs routing only beside explicit chain services. */
import { expect, test } from 'vitest'
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeatEngine } from '@panedesk/dsh-seat-engine/src/engine.ts'
import { composition } from '../../seat-engine/tests/composition-fixture.ts'
import { CompositionSeats } from '../../seat-engine/tests/composition-provider.ts'
import { admittedDefinition, loopback, persistCallback, response, services } from './routed-callback-fixture.ts'
import { fact } from '@panedesk/dsh-seat-engine/src/triggers.ts'
import { digest } from '@panedesk/dsh-seat-engine/src/journal.ts'
import { sourceId, seat, trigger } from '../../seat-engine/tests/fixtures.ts'

class RoutedSeats extends CompositionSeats {
  override resolve() { return Promise.resolve(admittedDefinition()) }
}

test.each(['early', 'late', 'replacement'] as const)('Loader resolves %s chain services and waits for owner commitment', async (timing) => {
  let closeLink: (() => Promise<void>) | undefined
  let body: T.DeliverSourceCallbackRequest | undefined
  let committed = false, received = 0
  const checks: T.SeatAuthorizationCheck[] = [], methods: string[] = []
  const chain = { name: 'callback-chain', inject: ['sessionLedger'], async apply(ctx: Context) {
    const nodeId = await ctx.get('sessionLedger')!.nodeId()
    const root = await mkdtemp(join(tmpdir(), 'routed-composition-'))
    const link = await loopback(root, nodeId, async (request) => {
      methods.push(request.method)
      if (request.method === 'chain.operation') return response(request, body ? committed
        ? { status: 'settled', method: 'source.deliverCallback', result: { status: 'committed',
          callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } }
        : { status: 'pending', effectState: 'unknown' } : { status: 'missing' })
      if (request.method !== 'source.deliverCallback') throw new Error('Unexpected method')
      body = request.payload; received++
      return response(request, { status: 'pending', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest })
    })
    closeLink = async () => { await link.close(); await rm(root, { recursive: true, force: true }) }
    ctx.provide('nodeWorkChainRouter', link.router)
    ctx.provide('nodeWorkChain', services(() => {
      const engine = ctx.get('seatEngine')
      if (!(engine instanceof SeatEngine)) throw new Error('Missing engine')
      return engine
    }, checks))
  } }
  const f = await composition(false, { builtins: { seats: RoutedSeats, chain },
    entries: timing === 'early' ? [{ name: 'cordis:chain' }] : [] })
  try {
    const engine = f.ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine)) throw new Error('Missing engine')
    const original = await persistCallback(engine)
    if (timing !== 'early') {
      const withdrawRouter = timing === 'replacement' ? f.ctx.provide('nodeWorkChainRouter', { route: async () => {
        throw new Error('No issuer must prevent routing')
      } }) : undefined
      const withdrawIssuer = timing === 'replacement' ? f.ctx.provide('nodeWorkChain', { outboxIssuer: async () => undefined }) : undefined
      await engine.drive()
      await expect.poll(() => engine.journal.projection.callbacks.get(original.callback.callbackId)?.responseClass).toBe('transient')
      expect(received).toBe(0)
      withdrawRouter?.(); withdrawIssuer?.()
      await f.ctx.loader.create({ name: 'cordis:chain' })
      await f.ctx.loader.await()
    }
    await new Promise<void>((resolve) => { f.ctx.inject(['nodeWorkChain', 'nodeWorkChainRouter'], () => { resolve() }) })
    await engine.drive()
    await expect.poll(async () => { await engine.drive(); return received }).toBe(1)
    await expect.poll(() => engine.journal.projection.callbacks.get(original.callback.callbackId)?.phase).toBe('retry-due')
    expect(received, JSON.stringify({ methods, checks })).toBe(1)
    committed = true
    await expect.poll(async () => { await engine.drive(); return engine.journal.projection.callbacks.get(original.callback.callbackId)?.phase }).toBe('delivered')
    expect(body).toEqual(original); expect(received).toBe(1)
  } finally { await f.close(); await closeLink?.() }
})

test('default Loader callback replies and storage add no chain fields or files', async () => {
  const f = await composition()
  try {
    const engine = f.ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine)) throw new Error('Missing engine')
    const seen: T.SeatCallbackPayload[] = []
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async (payload) => { seen.push(payload) } })
    const callback: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback-default' as T.CallbackId,
      sourceId, triggerId: trigger().triggerId, stateVersion: 1, seat, title: 'Original title', sessionId: 'session-default' as NonNullable<T.SeatCallbackPayload['sessionId']>,
      nodeId: engine.options.nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
    await engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { payload: callback, payloadDigest: digest(callback),
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await engine.drive()
    await expect.poll(() => engine.journal.projection.callbacks.get(callback.callbackId)?.phase).toBe('delivered')
    expect(JSON.stringify(seen)).toBe(JSON.stringify([callback]))
    expect(engine.journal.projection.callbacks.get(callback.callbackId)).toEqual({ payload: callback, payloadDigest: digest(callback),
      attempt: 1, phase: 'delivered', nextDue: null, responseClass: 'success' })
    const names = await readdir(f.home, { recursive: true })
    expect(names.filter(name => /chain-(sent|received|evidence)|chain-v1/.test(name))).toEqual([])
    const frames = await Promise.all((await readdir(`${engine.journal.root}/events`)).map(name => readFile(`${engine.journal.root}/events/${name}`, 'utf8')))
    expect(frames.join('')).not.toContain('nodeWorkChain')
    expect(frames.join('')).not.toContain('node-work-chain')
  } finally { await f.close() }
})
