/** A remote owner's pending receipt retains query-only ownership across worker recovery. */
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '../src/engine.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackChainRequest, CallbackRouterPort } from '../src/routed-callback-types.ts'
import { config, nodeId } from './fixtures.ts'
import { admittedDefinition, persistCallback, callbackIssuer, principalId } from './routed-callback-fixture.ts'

test.each([false, true])('queries a pending owner without stopping or resending across restart: %s', async (restart) => {
  const home = await mkdtemp(join(tmpdir(), 'callback-owner-pending-'))
  const contexts: Context[] = [], engines: SeatEngine[] = [], seen: CallbackChainRequest[] = []
  let body: T.DeliverSourceCallbackRequest, sent = false, committed = false
  let accepted: T.DeliverSourceCallbackRequest | undefined
  const reservations = new Set(['reservation-a'])
  const commitOwner = () => {
    expect(accepted).toEqual(body)
    expect(reservations.delete('reservation-a')).toBe(true)
    committed = true
  }
  const start = async () => {
    const ctx = new Context()
    const engine: SeatEngine = new SeatEngine(ctx, { home, nodeId, config: { ...config, ownerObserveIntervalMs: 60000,
      failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } } }, {
      seats: () => ({ resolve: async () => admittedDefinition(), list: async () => { throw new Error('Unused') },
        close: async () => { throw new Error('Unused') } }), ledger: () => ({ snapshot: async () => ({ asOf: 1, watermarks: {}, complete: true, rows: [] }) }),
      deliverCallback: (input, observation) => deliverRoutedCallback(ctx, engine, input, observation),
    })
    contexts.push(ctx); engines.push(engine)
    const issuer = callbackIssuer(engine.options.nodeId)
    const router: CallbackRouterPort = { route: async (request) => {
      seen.push(structuredClone(request))
      if (request.method === 'chain.operation') {
        expect(request.payload).toEqual({ key: { sourceNodeId: nodeId, principalId, sourceId: body.route.sourceId,
          ownerEpoch: body.route.ownerEpoch, method: 'source.deliverCallback', operationId: body.route.originalOperationId,
          callbackId: body.callback.callbackId }, payloadDigest: body.payloadDigest })
        return { method: request.method, status: 'ok', result: committed
          ? { status: 'settled', method: 'source.deliverCallback', result: { status: 'committed',
            callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } }
          : sent ? { status: 'pending', effectState: 'none', pendingReason: 'writeback-pending' } : { status: 'missing' } }
      }
      expect(request.method).toBe('source.deliverCallback')
      expect(request.payload).toEqual(body)
      expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
      if (request.method !== 'source.deliverCallback') throw new Error('Unexpected business method')
      accepted = structuredClone(request.payload)
      sent = true
      throw new Error('Delivery response lost after owner acceptance')
    } }
    ctx.provide('nodeWorkChain', issuer); ctx.provide('nodeWorkChainRouter', router)
    await engine.ready()
    return engine
  }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    let engine = await start()
    body = await persistCallback(engine)
    engine.registerPreopenRetention({ sourceId: body.route.sourceId, sourceOwnerNodeId: body.route.sourceOwnerNodeId, limitMs: 900000 })
    await engine.drive()
    expect(await engine.nodeStatus()).toMatchObject({ engine: 'running' })
    expect((await engine.nodeStatus()).failure).toBeUndefined()
    const pending = (await engine.callbackObservations({ limit: 10 })).items[0]!
    expect(pending).toMatchObject({ ownerPending: true, phase: 'retry-due',
      responseClass: 'unknown', lastDiagnostic: { cause: { code: 'callback-writeback-pending' } }, retrySummary: { count: 0 } })
    expect(reservations.has('reservation-a')).toBe(true)
    if (restart) {
      await engine.shutdown()
      engine = await start()
      engine.registerPreopenRetention({ sourceId: body.route.sourceId, sourceOwnerNodeId: body.route.sourceOwnerNodeId, limitMs: 900000 })
    }
    await vi.waitFor(async () => { await engine.drive(); expect(seen.filter(item => item.method === 'chain.operation').length).toBeGreaterThan(2) })
    expect(await engine.nodeStatus()).toMatchObject({ engine: 'running' })
    expect(seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
    // The simulated source commits its writeback and releases the original scope before the receipt.
    commitOwner()
    await vi.waitFor(async () => {
      await engine.drive()
      expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.phase).toBe('delivered')
    })
    expect(reservations.size).toBe(0)
    expect((await engine.nodeStatus()).failure).toBeUndefined()
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.retrySummary?.count).toBe(0)
    expect(seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
  } finally {
    for (const engine of engines) await engine.shutdown()
    for (const ctx of contexts) await ctx.fiber.dispose()
    log.mockRestore(); await rm(home, { recursive: true, force: true })
  }
})

test('a genuinely unknown owner outcome still stops the worker without another business call', async () => {
  const home = await mkdtemp(join(tmpdir(), 'callback-owner-unknown-')), ctx = new Context()
  let sent = 0
  const engine: SeatEngine = new SeatEngine(ctx, { home, nodeId, config: { ...config, ownerObserveIntervalMs: 60000,
    failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } } }, {
    seats: () => ({ resolve: async () => admittedDefinition(), list: async () => { throw new Error('Unused') },
      close: async () => { throw new Error('Unused') } }), ledger: () => ({ snapshot: async () => ({ asOf: 1, watermarks: {}, complete: true, rows: [] }) }),
    deliverCallback: (input, observation) => deliverRoutedCallback(ctx, engine, input, observation),
  })
  const issuer = callbackIssuer(engine.options.nodeId)
  const router: CallbackRouterPort = { route: async (request) => {
    if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: sent
      ? { status: 'pending', effectState: 'unknown', pendingReason: 'writeback-outcome-unknown' } : { status: 'missing' } }
    sent++; throw new Error('Owner outcome unknown')
  } }
  ctx.provide('nodeWorkChain', issuer); ctx.provide('nodeWorkChainRouter', router)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await engine.ready()
    const body = await persistCallback(engine)
    engine.registerPreopenRetention({ sourceId: body.route.sourceId, sourceOwnerNodeId: body.route.sourceOwnerNodeId, limitMs: 900000 })
    await engine.drive()
    expect(await engine.nodeStatus()).toMatchObject({ engine: 'unavailable', failure: { retryable: false } })
    await engine.drive(); expect(sent).toBe(1)
  } finally { await engine.shutdown(); await ctx.fiber.dispose(); log.mockRestore(); await rm(home, { recursive: true, force: true }) }
})
