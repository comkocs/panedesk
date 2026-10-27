/** Transport refusals recover only through a fresh exact owner query. */
import { afterEach, expect, test, vi } from 'vitest'
import * as Host from '@panedesk/dsh-host-admin'
import type * as Seat from '@panedesk/dsh-seat'
import { ChainRouter } from '../src/chain-router.ts'
import { ChainRetainedEvidence } from '../src/chain-retained.ts'
import { ChainStore } from '../src/chain-store.ts'
import { chainDigest, decodeChainRequest, decodeChainResponse } from '../src/chain-codec.ts'
import { chainFailure, chainKey, chainKeyText } from '../src/chain-identity.ts'
import type { ChainCapability, ChainRequest } from '../src/chain-types.ts'
import { networkInput, networkPrepared } from './chain-network-fixture.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers()
})
async function fixture(code: 'node-deadline-exceeded' | 'node-tunnel-disconnected' = 'node-deadline-exceeded') {
  vi.useFakeTimers({ toFake: ['Date'] })
  const input = networkInput('none-recovery', new Date(Date.now() + 1000).toISOString())
  const original = decodeChainRequest(input.request)
  const none = chainFailure(original, code, code === 'node-deadline-exceeded' ? 'deadline-exceeded' : 'tunnel-disconnected')
  // This is the old on-disk generation: no recovery metadata is required.
  const records = new Map([['chain-v1.json', JSON.stringify({ version: 'node-work-chain/v1', entries: {
    [Host.digest(chainKeyText(chainKey(original)))]: { request: original, response: none },
  } })]])
  const files: Host.PrivateFiles = { prepare: async () => {}, read: async name => records.get(name) ?? null,
    write: async (name, content) => { records.set(name, content) }, remove: async (name) => { records.delete(name) },
    lock: async () => async () => {} }
  const store = new ChainStore(files, 262144, 100)
  await store.load()
  const evidence = new ChainRetainedEvidence(files, 262144, 100, 'node-a', 'node-b')
  const capability: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: 65536,
    methods: ['source.prepareOpening', 'chain.operation'] }
  const state = { available: true, ready: true, authorized: true, query: 'missing', executions: 0, writes: 0,
    lost: false }
  const seen: ChainRequest[] = []
  if (original.method !== 'source.prepareOpening') throw new Error('Unexpected fixture method')
  const result = networkPrepared(original.payload)
  const wire = vi.spyOn(Host, 'callLoopback').mockImplementation(async (_port, _credential, value) => {
    const request = decodeChainRequest(value); seen.push(request)
    if (request.method === 'chain.operation') {
      if (state.query === 'timeout') throw new Error('Query timed out')
      if (state.query === 'disconnect') throw new Host.LoopbackConnectionError('Peer disconnected')
      if (state.query === 'denied') return chainFailure(request, 'node-delegation-rejected', 'method-not-allowed')
      const response = decodeChainResponse({ ...request, status: 'ok', result: state.query === 'rejected'
        ? { status: 'settled', method: original.method, result: { status: 'rejected', error: { code: 'unavailable',
          message: 'Owner refused operation', alternative: 'Review owner state', retryable: false, effectState: 'none' } } }
        : state.query === 'committed' ? { status: 'settled', method: original.method, result }
          : state.query === 'unknown' ? { status: 'pending', effectState: 'unknown' } : { status: 'missing' } }, request)
      return response
    }
    state.executions++; state.writes++; state.query = 'committed'
    if (state.lost) throw new Error('Response lost after commit')
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
  const issuerFor = vi.fn(async (_request: ChainRequest) => state.authorized ? issuer : undefined)
  const router = new ChainRouter({ directory: '.', nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
    listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 2,
    maxStoreBytes: 262144, maxOperations: 100, staleMs: 10 }, store,
  () => ({ sourceNodeId: 'node-a', targetNodeId: 'node-b', epoch: 'test', credential: 'unused' }), () => state.available,
  () => state.ready ? { local: capability, remote: capability } : {}, evidence)
  cleanups.push(async () => { await router.close(); await store.close(); await evidence.close() })
  return { original, none, records, files, store, router, state, seen, wire, issuer, issuerFor, result,
    recover: () => router.recover(issuerFor) }
}

test.each(['node-deadline-exceeded', 'node-tunnel-disconnected'] as const)(
  'recovers a legacy %s receipt with one exact missing permit and preserves its audit receipt', async (code) => {
    const f = await fixture(code)
    expect(f.store.pending()).toEqual([f.original])
    await Promise.all([f.recover(), f.recover()])
    expect(f.seen.map(request => request.method)).toEqual(['chain.operation', f.original.method])
    expect(f.seen[0]?.method === 'chain.operation' && f.seen[0].payload).toEqual({ key: chainKey(f.original),
      payloadDigest: f.original.payloadDigest })
    expect(f.seen[1]).toMatchObject({ payload: f.original.payload, payloadDigest: f.original.payloadDigest,
      operationId: f.original.operationId })
    expect(f.seen[1]?.requestId).not.toBe(f.original.requestId)
    expect(f.state).toMatchObject({ executions: 1, writes: 1 })
    expect(f.store.query(chainKey(f.original), f.original.payloadDigest)).toMatchObject({ state: 'settled', response: { status: 'ok' } })
    expect(f.records.get('chain-v1.json')).toContain(JSON.stringify(f.none))
    const restored = new ChainStore(f.files, 262144, 100)
    await restored.load(); expect(restored.pending()).toEqual([]); await restored.close()
  })

test.each(['unknown', 'timeout', 'disconnect', 'denied', 'not-ready', 'offline', 'no-issuer'])(
  'does not consume a replay permit when the owner query is %s', async (mode) => {
    const f = await fixture()
    f.state.query = mode
    f.state.ready = mode !== 'not-ready'; f.state.available = mode !== 'offline'; f.state.authorized = mode !== 'no-issuer'
    await f.recover()
    expect(f.state.executions).toBe(0)
    expect(f.seen.every(request => request.method === 'chain.operation')).toBe(true)
    expect(f.store.pending()).toEqual([f.original])
  })

test.each(['committed', 'rejected'])('repairs a %s owner receipt without dispatching the retained none again', async (status) => {
  const f = await fixture(); f.state.query = status
  await f.recover()
  expect(f.seen.map(request => request.method)).toEqual(['chain.operation'])
  expect(f.store.pending()).toEqual([])
  expect(f.store.query(chainKey(f.original), f.original.payloadDigest)).toMatchObject({ state: 'settled', response: { status: 'ok' } })
  expect(f.records.get('chain-v1.json')).toContain(JSON.stringify(f.none))
})

test('queries a lost replay receipt and never executes the committed key twice', async () => {
  const f = await fixture(); f.state.lost = true
  await f.recover(); expect(f.state.executions).toBe(1)
  expect(f.store.pending()).toEqual([f.original])
  await f.recover()
  expect(f.state).toMatchObject({ executions: 1, writes: 1 })
  expect(f.store.pending()).toEqual([])
})

test('a replay whose evidence publication expires waits for another authenticated missing query', async () => {
  const f = await fixture()
  const publish = f.files.write.bind(f.files)
  let expire = true
  f.files.write = async (name, text) => {
    await publish(name, text)
    if (expire && name === 'evidence-v1.json' && text.includes('source.prepareOpening')) {
      expire = false; vi.setSystemTime(Date.now() + 1001)
    }
  }
  await f.recover()
  expect(f.seen.map(request => request.method)).toEqual(['chain.operation'])
  expect(f.store.pending()).toEqual([f.original])
  await f.recover()
  expect(f.seen.map(request => request.method)).toEqual(['chain.operation', 'chain.operation', f.original.method])
  expect(f.state.executions).toBe(1)
  const retained = Host.parseJson(f.records.get('chain-v1.json')!, 262144)
  if (!Host.object(retained) || !Host.object(retained.entries)) throw new Error('Missing store')
  const entry = Object.values(retained.entries)[0]
  if (!Host.object(entry) || !Host.object(entry.recovery)) throw new Error('Missing recovery history')
  expect(entry.recovery.history).toHaveLength(2)
})

test('a changed payload conflicts and an owner epoch change cannot reactivate the original key', async () => {
  const f = await fixture()
  if (f.original.method !== 'source.prepareOpening') throw new Error('Unexpected fixture method')
  const payload = { ...f.original.payload, taskIds: ['different-task'] as Seat.SeatTaskId[] }
  const changed = decodeChainRequest({ ...f.original, payload, payloadDigest: chainDigest(f.original.method, payload),
    delegation: { ...f.original.delegation, requestDigest: chainDigest(f.original.method, payload) } })
  expect(await f.store.admit(changed)).toEqual({ state: 'conflict' })
  expect(f.store.query({ ...chainKey(f.original), ownerEpoch: 'changed-epoch' as Seat.OwnerEpoch }, f.original.payloadDigest))
    .toEqual({ state: 'missing' })
  f.issuerFor.mockImplementation(async request => chainKey(request).ownerEpoch === 'changed-epoch' ? f.issuer : undefined)
  await f.recover(); expect(f.wire).not.toHaveBeenCalled()
  expect(f.store.pending()).toEqual([f.original])
})

test.each(['before-cas', 'after-cas', 'after-send', 'after-receipt'] as const)(
  'restart at %s retains the original receipt and requires fresh owner evidence', async (boundary) => {
    const f = await fixture(), replay = { ...f.original, requestId: 'replay-attempt' as ChainRequest['requestId'] }
    if (boundary !== 'before-cas') {
      const expected = f.store.query(chainKey(f.original), f.original.payloadDigest)
      expect(await f.store.reactivate(replay, expected)).toBe(true)
      expect(await f.store.reactivate({ ...replay, requestId: 'duplicate' as ChainRequest['requestId'] }, expected)).toBe(false)
      await f.store.settle(f.original, f.none, true)
      expect(f.store.query(chainKey(f.original), f.original.payloadDigest)).toEqual({ state: 'pending' })
    }
    if (boundary === 'after-send' || boundary === 'after-receipt') f.state.query = 'committed'
    if (boundary === 'after-receipt') {
      await f.store.settle(replay, decodeChainResponse({ ...replay, status: 'ok', result: f.result }, replay))
      await f.store.settle(f.original, f.none, true)
    }
    const restored = new ChainStore(f.files, 262144, 100); await restored.load()
    expect(restored.pending()).toEqual(boundary === 'after-receipt' ? [] : [f.original])
    expect(f.records.get('chain-v1.json')).toContain(JSON.stringify(f.none))
    await restored.close()
    await f.recover()
    expect(f.state.executions).toBe(boundary === 'before-cas' || boundary === 'after-cas' ? 1 : 0)
    expect(f.store.pending()).toEqual([])
  })

test('same-key outbox dispatch waits for hello recovery and cannot spend its missing permit twice', async () => {
  const f = await fixture()
  const recovering = f.recover()
  const grant = await f.issuer.check({ operationId: f.original.operationId, requestDigest: f.original.payloadDigest })
  if ('status' in grant) throw new Error('Missing grant')
  const duplicate = decodeChainRequest({ ...f.original, requestId: 'outbox-attempt', delegation: {
    ...f.original.delegation, authorizationRef: grant.fact.authorizationId,
  } })
  await Promise.all([recovering, f.router.route(duplicate, grant), f.recover()])
  expect(f.state.executions).toBe(1)
  expect(f.seen.filter(request => request.method === 'chain.operation')).toHaveLength(1)
  await f.store.settle(f.original, f.none, true)
  expect(f.store.query(chainKey(f.original), f.original.payloadDigest)).toMatchObject({ state: 'settled', response: { status: 'ok' } })
})

test('an owner transport-shaped refusal is marked as owner evidence and never becomes a replay candidate', async () => {
  const f = await fixture()
  f.wire.mockImplementation(async (_port, _credential, input) => {
    const request = decodeChainRequest(input)
    return request.method === 'chain.operation' ? decodeChainResponse({ ...request, status: 'ok', result: { status: 'missing' } }, request)
      : chainFailure(request, 'node-deadline-exceeded', 'deadline-exceeded')
  })
  await f.recover()
  expect(f.store.pending()).toEqual([])
  const restored = new ChainStore(f.files, 262144, 100); await restored.load()
  expect(restored.pending()).toEqual([]); await restored.close()
})

test('an owner business refusal remains terminal and is never reopened as a transport none', async () => {
  const f = await fixture()
  const records = new Map<string, string>()
  const store = new ChainStore({ ...f.files, read: async name => records.get(name) ?? null,
    write: async (name, text) => { records.set(name, text) } }, 262144, 100)
  await store.load(); await store.admit(f.original)
  const error = { code: 'unavailable', message: 'Owner stopped this operation', alternative: 'Review owner state',
    retryable: false, effectState: 'none' }
  const refusal = decodeChainResponse({ ...f.original, status: 'ok', result: { status: 'rejected', error } }, f.original)
  await store.settle(f.original, refusal)
  expect(store.pending()).toEqual([])
  expect(store.query(chainKey(f.original), f.original.payloadDigest)).toEqual({ state: 'settled', response: refusal })
  await store.close()
})
