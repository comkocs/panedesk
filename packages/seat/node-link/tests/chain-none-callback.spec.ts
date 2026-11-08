/** Old sender refusals and durable seat uncertainty converge without weakening the outbox barrier. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import * as Host from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainRuntime } from '../src/chain-runtime.ts'
import { ChainStore } from '../src/chain-store.ts'
import { ChainBusinessRegistry } from '../src/chain-business.ts'
import { decodeChainRequest, decodeChainResponse } from '../src/chain-codec.ts'
import { chainFailure, chainKey, chainKeyText } from '../src/chain-identity.ts'
import { CallbackOutbox } from '../../seat-engine/src/outbox.ts'
import { SourceRegistry } from '../../seat-engine/src/sources.ts'
import { deliverRoutedCallback } from '../../seat-engine/src/routed-callback.ts'
import { fact } from '../../seat-engine/src/triggers.ts'
import { harness, seat } from '../../seat-engine/tests/fixtures.ts'
import { admittedDefinition, persistCallback, principalId, owner } from '../../seat-engine/tests/routed-callback-fixture.ts'
import type { ChainRequest } from '../src/chain-types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers()
})

test.each(['before-ready', 'after-ready', 'before-timeout', 'after-timeout'] as const)(
  'recovers %s publication and durable callback uncertainty through lifecycle recovery', async (order) => {
    const h = await harness(); cleanups.push(h.close)
    h.definitions.set(seat, admittedDefinition())
    const body = await persistCallback(h.engine)
    const legacy = order === 'before-ready' || order === 'after-ready'
    if (legacy) await h.engine.journal.commit(view => [fact({ kind: 'callback/attempted', data: {
      ...view.callbacks.get(body.callback.callbackId)!, responseClass: 'unknown', phase: 'retry-due', nextDue: null,
    } })])
    await h.engine.shutdown()
    const engine = await h.start()
    vi.useFakeTimers({ toFake: ['Date'] })
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    const original = decodeChainRequest({ version: 'node-link/v1', requestId: 'old-callback-attempt',
      sourceNodeId: engine.options.nodeId, targetNodeId: owner, operationId: body.route.originalOperationId,
      deadline: expiresAt, hop: 1, method: 'source.deliverCallback', payload: body, payloadDigest: body.payloadDigest,
      delegation: { kind: 'node-delegation', hop: 1, authorizationRef: 'old-grant', principalId,
        sourceNodeId: engine.options.nodeId, targetNodeId: owner, operationId: body.route.originalOperationId,
        requestDigest: body.payloadDigest, taskIds: [], seat, expiresAt } })
    const none = chainFailure(original, 'node-deadline-exceeded', 'deadline-exceeded')
    const records = new Map<string, string>(legacy ? [['/chain-sent/chain-v1.json', JSON.stringify({ version: 'node-work-chain/v1', entries: {
      [Host.digest(chainKeyText(chainKey(original)))]: { request: original, response: none },
    } })]] : [])
    let delay = !legacy, release!: () => void, publishing!: () => void
    const publication = new Promise<void>((resolve) => { publishing = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const files = (directory: string): Host.PrivateFiles => ({ prepare: async () => {},
      read: async name => records.get(`${directory}/${name}`) ?? null,
      write: async (name, text) => {
        records.set(`${directory}/${name}`, text)
        if (delay && directory === '/chain-sent' && name === 'chain-v1.json') {
          delay = false; publishing()
          if (order === 'after-timeout') await held
          vi.setSystemTime(Date.now() + engine.options.config.callbackTimeoutMs + 1)
        }
      },
      remove: async (name) => { records.delete(`${directory}/${name}`) }, lock: async () => async () => {} })
    const issuer: Seat.SeatAuthorizationIssuer = { check: async (request) => {
      const seat = original.delegation.seat
      const fact: Seat.SeatIssuedAuthorizationFact = { kind: 'human', principalId, nodeId: original.sourceNodeId, origin: 'manual',
        ...(seat === undefined ? {} : { seat }), taskIds: original.delegation.taskIds, policyRevision: 1, decision: 'allowed', reasonCode: 'allowed',
        authorizationId: randomUUID() as Seat.AuthorizationRef, operationId: request.operationId,
        requestDigest: request.requestDigest, checkedAt: new Date().toISOString() }
      return { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
    } }
    const issuerFor = async (request: ChainRequest) => Host.digest(chainKey(request)) === Host.digest(chainKey(original))
      && (request.method === 'chain.operation' ? request.payload.payloadDigest : request.payloadDigest) === original.payloadDigest
      ? issuer : undefined
    const business = new ChainBusinessRegistry()
    const seen: ChainRequest[] = []
    let executions = 0, writebacks = 0, committed = false
    vi.spyOn(Host, 'callLoopback').mockImplementation(async (_port, _credential, input) => {
      const request = decodeChainRequest(input); seen.push(request)
      if (request.method === 'chain.operation') return decodeChainResponse({ ...request, status: 'ok', result: committed
        ? { status: 'settled', method: original.method, result: { status: 'committed', callbackId: body.callback.callbackId,
          payloadDigest: body.payloadDigest } } : { status: 'missing' } }, request)
      expect(chainKey(request)).toEqual(chainKey(original)); expect(request.payload).toEqual(body)
      executions++; writebacks++; committed = true
      return decodeChainResponse({ ...request, status: 'ok', result: { status: 'committed', callbackId: body.callback.callbackId,
        payloadDigest: body.payloadDigest } }, request)
    })
    const runtime = new ChainRuntime({ directory: '/', nodeId: engine.options.nodeId, peerNodeId: owner,
      peerName: 'peer', listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 4,
      maxStoreBytes: 262144, maxOperations: 100, staleMs: 10 }, {
      maxControlPending: 2, local: { methods: [], ready: async () => {} }, outboxIssuer: issuerFor,
      policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
        authorize: async () => { throw new Error('Unexpected ingress') } },
    }, business, files, () => ({ sourceNodeId: engine.options.nodeId, targetNodeId: owner,
      epoch: 'test', credential: 'unused' }), () => true, () => true)
    cleanups.push(() => runtime.close())
    const capability = { capability: 'node-work-chain/v1' as const, maxFrameBytes: 65536,
      methods: ['chain.operation', 'source.deliverCallback'] as Seat.NodeWorkChainMethod[] }
    h.ctx.provide('nodeWorkChain', { outboxIssuer: issuerFor })
    h.ctx.provide('nodeWorkChainRouter', runtime.router)
    const sources = new SourceRegistry(); cleanups.push(() => sources.close())
    const outbox = new CallbackOutbox(engine.journal, sources, engine.options.config,
      input => deliverRoutedCallback(h.ctx, engine, input))
    cleanups.push(() => outbox.close())
    if (order === 'before-ready') runtime.observe(capability)
    await runtime.ready()
    if (order !== 'before-ready') runtime.observe(capability)
    if (!legacy) {
      if (order === 'after-timeout') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const first = outbox.deliver(Date.now())
      await publication
      if (order === 'after-timeout') {
        await vi.advanceTimersByTimeAsync(engine.options.config.callbackTimeoutMs + 1)
        await first
        expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
        release()
        vi.useRealTimers(); vi.useFakeTimers({ toFake: ['Date'] })
      } else await first
      await expect.poll(() => records.get('/chain-sent/chain-v1.json')).toContain('node-deadline-exceeded')
      expect(executions).toBe(0)
      expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
      expect(outbox.observations().find(delivery => delivery.payload.callbackId === body.callback.callbackId)?.responseClass)
        .toBe(order === 'after-timeout' ? 'unknown' : 'transient')
      runtime.observe(capability)
    }
    // The lifecycle owns recovery; the test does not call router.recover or rewrite retained state.
    await expect.poll(() => executions).toBe(1)
    await outbox.deliver(Date.now() + engine.options.config.callbackRetryMaxMs + 1)
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject({ phase: 'delivered', responseClass: 'success' })
    expect(executions).toBe(1); expect(writebacks).toBe(1)
    expect(seen.filter(request => request.method === original.method)).toHaveLength(1)
    expect(records.get('/chain-sent/chain-v1.json')).toContain(legacy ? JSON.stringify(none) : 'node-deadline-exceeded')
    const pausedStore = new ChainStore(files('/paused'), 262144, 100)
    await pausedStore.load(); await pausedStore.admit(original)
    const paused = decodeChainResponse({ ...original, status: 'ok', result: { status: 'paused',
      callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest, error: { code: 'unavailable',
        message: 'Owner paused callback', alternative: 'Review owner state', retryable: false, effectState: 'none' } } }, original)
    await pausedStore.settle(original, paused)
    expect(pausedStore.pending()).toEqual([])
    await pausedStore.close()
    const reloaded = new ChainStore(files('/paused'), 262144, 100)
    await reloaded.load(); expect(reloaded.pending()).toEqual([]); await reloaded.close()
  })
