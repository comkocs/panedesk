/** Initiating pre-send refusals stay final while in-flight unknown retains exact-key recovery. */
import { afterEach, expect, test, vi } from 'vitest'
import * as Host from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainRuntime } from '../src/chain-runtime.ts'
import { ChainStore } from '../src/chain-store.ts'
import { ChainBusinessRegistry } from '../src/chain-business.ts'
import { chainDigest, decodeChainRequest, decodeChainResponse } from '../src/chain-codec.ts'
import { chainFailure, chainKey, chainKeyText } from '../src/chain-identity.ts'
import type { ChainCapability, ChainRequest } from '../src/chain-types.ts'
import { networkInput, networkPrepared } from './chain-network-fixture.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers()
})

async function fixture(mode: 'offline' | 'connection' | 'deadline' | 'unknown' | 'legacy-deadline' | 'legacy-connection') {
  vi.useFakeTimers({ toFake: ['Date'] })
  const input = networkInput('opening-recovery-scope', new Date(Date.now() + 1000).toISOString())
  const original = decodeChainRequest(input.request)
  if (original.method !== 'source.prepareOpening') throw new Error('Unexpected fixture method')
  const result = networkPrepared(original.payload)
  const records = new Map<string, string>()
  const state = { online: mode !== 'offline', fail: true, expire: mode === 'deadline', executions: 0 }
  const files = (directory: string): Host.PrivateFiles => ({ prepare: async () => {},
    read: async name => records.get(`${directory}/${name}`) ?? null,
    write: async (name, text) => {
      records.set(`${directory}/${name}`, text)
      if (state.expire && directory === '/chain-sent' && name === 'chain-v1.json') {
        state.expire = false; vi.setSystemTime(Date.now() + 1001)
      }
    }, remove: async (name) => { records.delete(`${directory}/${name}`) }, lock: async () => async () => {} })
  if (mode.startsWith('legacy-')) {
    const code = mode === 'legacy-deadline' ? 'node-deadline-exceeded' : 'node-tunnel-disconnected'
    const response = chainFailure(original, code, code === 'node-deadline-exceeded' ? 'deadline-exceeded' : 'tunnel-disconnected')
    records.set('/chain-sent/chain-v1.json', JSON.stringify({ version: 'node-work-chain/v1', entries: {
      [Host.digest(chainKeyText(chainKey(original)))]: { request: original, response },
    } }))
  }
  const seen: ChainRequest[] = []
  const wire = vi.spyOn(Host, 'callLoopback').mockImplementation(async (_port, _credential, value) => {
    const request = decodeChainRequest(value); seen.push(request)
    if (state.fail) {
      if (mode === 'unknown') throw new Error('In-flight result unknown')
      throw new Host.LoopbackConnectionError('Connection unavailable before dispatch')
    }
    if (request.method === 'chain.operation') return decodeChainResponse({ ...request, status: 'ok', result: { status: 'missing' } }, request)
    state.executions++
    expect(chainKey(request)).toEqual(chainKey(original)); expect(request.payload).toEqual(original.payload)
    return decodeChainResponse({ ...request, status: 'ok', result }, request)
  })
  let sequence = 0
  const issuer: Seat.SeatAuthorizationIssuer = { check: async (request) => {
    const fact: Seat.SeatIssuedAuthorizationFact = { ...input.fact, kind: 'human', origin: 'manual', decision: 'allowed',
      reasonCode: 'allowed', nodeId: original.sourceNodeId, principalId: original.delegation.principalId,
      authorizationId: `fresh-${++sequence}` as Seat.AuthorizationRef, operationId: request.operationId,
      requestDigest: request.requestDigest, taskIds: original.delegation.taskIds, checkedAt: new Date().toISOString() }
    return { fact } as Pick<Seat.SeatAuthorizationGrant, 'fact'> as Seat.SeatAuthorizationGrant
  } }
  const issuerFor = vi.fn(async (_request: ChainRequest) => issuer)
  const capability: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: 65536,
    methods: ['source.prepareOpening', 'chain.operation'] }
  const start = async () => {
    const runtime = new ChainRuntime({ directory: '/', nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
      listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 4,
      maxStoreBytes: 262144, maxOperations: 100, staleMs: 10 }, {
      maxControlPending: 2, local: { methods: [], ready: async () => {} }, outboxIssuer: issuerFor,
      policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
        authorize: async () => { throw new Error('Unexpected ingress') } },
    }, new ChainBusinessRegistry(), files, () => ({ sourceNodeId: 'node-a', targetNodeId: 'node-b',
      epoch: 'test', credential: 'unused' }), () => true, () => state.online, () => { state.online = false })
    cleanups.push(() => runtime.close())
    await runtime.ready()
    return runtime
  }
  const authorize = async (request: ChainRequest) => {
    const grant = await issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest })
    if ('status' in grant) throw new Error('Missing grant')
    return { request: decodeChainRequest({ ...request,
      delegation: { ...request.delegation, authorizationRef: grant.fact.authorizationId } }), grant }
  }
  const runtime = await start()
  if (!mode.startsWith('legacy-')) {
    runtime.observe(capability)
    await runtime.router.recover(issuerFor)
  }
  const readStore = async () => {
    const store = new ChainStore(files('/chain-sent'), 262144, 100)
    await store.load(); cleanups.push(() => store.close())
    return store
  }
  return { original, records, state, seen, wire, issuerFor, capability, start, authorize, runtime, readStore }
}

test.each(['offline', 'connection', 'deadline', 'legacy-deadline', 'legacy-connection'] as const)(
  'keeps an initiating %s refusal final across hello, explicit recovery, reconciliation and restart', async (mode) => {
    const f = await fixture(mode)
    let refusal
    if (!mode.startsWith('legacy-')) {
      const authorized = await f.authorize(f.original)
      refusal = await f.runtime.router.route(authorized.request, authorized.grant)
      expect(refusal).toMatchObject({ status: 'unavailable', error: { effectState: 'none',
        code: mode === 'deadline' ? 'node-deadline-exceeded' : 'node-tunnel-disconnected' } })
      expect(f.seen).toHaveLength(mode === 'connection' ? 1 : 0)
    } else {
      const stored = (await f.readStore()).query(chainKey(f.original), f.original.payloadDigest)
      if (stored.state !== 'settled') throw new Error('Missing legacy receipt')
      refusal = stored.response
    }
    const retained = f.records.get('/chain-sent/chain-v1.json')
    expect(retained === undefined).toBe(mode === 'offline')
    f.state.online = true; f.state.fail = false; f.seen.length = 0; f.issuerFor.mockClear()
    for (let pass = 0; pass < 2; pass++) {
      const runtime = pass === 0 ? f.runtime : await f.start()
      runtime.observe(f.capability)
      await runtime.router.recover(f.issuerFor)
      runtime.observe(f.capability)
      await runtime.router.recover(f.issuerFor)
      expect(f.state.executions).toBe(0)
      expect(f.seen).toEqual([])
      expect(f.issuerFor).not.toHaveBeenCalled()
      const store = await f.readStore()
      expect(store.pending()).toEqual([])
      const expected = store.query(chainKey(f.original), f.original.payloadDigest)
      expect(await store.reactivate({ ...f.original, requestId: 'blocked-attempt' as ChainRequest['requestId'] }, expected)).toBe(false)
      if (mode !== 'offline') {
        const payload = { key: chainKey(f.original), payloadDigest: f.original.payloadDigest }
        const payloadDigest = chainDigest('chain.operation', payload)
        const query = await f.authorize(decodeChainRequest({ ...f.original, method: 'chain.operation', payload, payloadDigest,
          deadline: new Date(Date.now() + 1000).toISOString(), delegation: { ...f.original.delegation,
            requestDigest: payloadDigest, expiresAt: new Date(Date.now() + 1000).toISOString() } }))
        if (query.request.method !== 'chain.operation') throw new Error('Unexpected query')
        expect(await runtime.router.reconcile(f.original, query.request, query.grant))
          .toEqual({ ...refusal, method: 'chain.operation', requestId: query.request.requestId })
        expect(f.seen).toEqual([])
        expect(f.records.get('/chain-sent/chain-v1.json')).toBe(retained)
      }
      await runtime.close()
    }
  })

test('recovers an initiating response-less unknown once after authenticated missing', async () => {
  const f = await fixture('unknown'), authorized = await f.authorize(f.original)
  expect(await f.runtime.router.route(authorized.request, authorized.grant))
    .toMatchObject({ status: 'uncertain', error: { effectState: 'unknown' } })
  expect((await f.readStore()).query(chainKey(f.original), f.original.payloadDigest)).toEqual({ state: 'pending' })
  await f.runtime.close()
  f.state.fail = false; f.seen.length = 0
  const restarted = await f.start()
  restarted.observe(f.capability)
  await restarted.router.recover(f.issuerFor)
  await restarted.router.recover(f.issuerFor)
  expect(f.seen.map(request => request.method)).toEqual(['chain.operation', 'source.prepareOpening'])
  expect(f.seen[1]?.requestId).not.toBe(f.original.requestId)
  expect(f.state.executions).toBe(1)
  expect((await f.readStore()).pending()).toEqual([])
})
