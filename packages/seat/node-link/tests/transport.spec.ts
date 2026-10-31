/** Node doubles exercise durable retries, lost responses and identity checks without real SSH connections. */
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { OperationStore, PosixPrivateFiles, digest, listenLoopback, object } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION, type NodeLinkRuntimeConfig, type NodeWireRequest, type NodeLinkExecutor } from '../src/index.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { NodeReceiver, failure } from '../src/receiver.ts'
import { NodeRouter } from '../src/router.ts'
import { decodeChainCapability } from '../src/chain-codec.ts'
import { helloRefusal } from '../src/chain-hello.ts'
import type { ChainCapability } from '../src/chain-types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100 }
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'node-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const value = new OperationStore(new PosixPrivateFiles(root, process.getuid!()), limits.maxStoreBytes, limits.maxOperations)
  await value.load()
  return value
}
function frame(operationId = 'operation-a', seat = 'seat-a'): NodeWireRequest {
  const payload = { operationId, seat, nodeId: 'node-b' }
  return decodeRequest({ version: NODE_LINK_VERSION, requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId, deadline: new Date(Date.now() + 60000).toISOString(), hop: 1, method: 'seat.wake', payload,
    payloadDigest: digest(payload), delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'grant-a',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId, requestDigest: digest(payload), taskIds: [],
      expiresAt: new Date(Date.now() + 60000).toISOString() } })
}
function provider(execute: NodeLinkExecutor['execute']): NodeLinkExecutor {
  return { authorize: async () => true, execute, status: async () => ({ nodeId: frame().targetNodeId, nodeName: 'peer',
    engine: 'running', openEngineWindows: 3, limit: 4, readyAt: null }) }
}

test('executes identical operations once, rejects changed arguments and retains results after restart', async () => {
  const durable = await store()
  let calls = 0
  const executor = provider(async (request) => { calls++; return failure(request, 'cross-node-unsupported') })
  const receiver = new NodeReceiver('node-b', 'node-a', durable, () => executor)
  await receiver.receive(frame())
  const repeat = decodeRequest({ ...frame(), requestId: 'request-b' })
  expect(await receiver.receive(repeat)).toMatchObject({ requestId: 'request-b' })
  expect(calls).toBe(1)
  expect(await receiver.receive(frame('operation-a', 'seat-b'))).toMatchObject({ error: { code: 'node-operation-conflict' } })
  const restarted = new NodeReceiver('node-b', 'node-a', durable, () => executor)
  await restarted.receive(frame())
  expect(calls).toBe(1)
  expect(await new NodeReceiver('node-b', 'other', durable, () => executor).receive(frame()))
    .toMatchObject({ error: { code: 'node-authentication-failed', effectState: 'none' } })
})

test('queries receipts without replay after response loss, rejects disconnected calls and retains stale window counts', async () => {
  const received = await store(), sent = await store()
  let calls = 0, drop = true
  const executor = provider(async (request) => { calls++; return failure(request, 'cross-node-unsupported') })
  const receiver = new NodeReceiver('node-b', 'node-a', received, () => executor)
  const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-b', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
  const listener = await listenLoopback(0, limits, () => auth, async (value) => {
    if (object(value) && value.type === 'hello') return { version: NODE_LINK_VERSION, nodeId: 'node-b', epoch: auth.epoch,
      nonce: value.nonce, status: await executor.status() }
    if (object(value) && value.type === 'receipt') return received.query(JSON.stringify(['node-a', 'principal-a', 'operation-a']))
    const result = await receiver.receive(decodeRequest(value))
    if (drop) { drop = false; throw new Error('Simulated response loss') }
    return result
  })
  cleanups.push(() => listener.close())
  const options: NodeLinkRuntimeConfig = { ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
    directory: 'unused', listenPort: 0, peerPort: listener.port, staleMs: 10 }
  const router = new NodeRouter(options, auth, sent, () => true)
  expect(await router.route(frame())).toMatchObject({ error: { effectState: 'none' } })
  expect(await router.handshake()).toBe(true)
  expect(await router.route(frame())).toMatchObject({ error: { code: 'node-outcome-unknown', effectState: 'unknown' } })
  expect(await router.route(frame('operation-b'))).toMatchObject({ error: { code: 'node-outcome-unknown' } })
  expect(await router.route(frame())).toMatchObject({ error: { code: 'cross-node-unsupported' } })
  expect(calls).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await router.status()).toMatchObject([{ linkState: 'stale', status: { openEngineWindows: 3 } }])
  router.disconnect()
  expect(await router.route(frame('operation-c'))).toMatchObject({ error: { effectState: 'none' } })
})

test.each(['retained', 'absent', 'stopped-after-query'] as const)(
  'retries only a missing remote direct-message receipt and preserves unknown while disconnected: %s', async (mode) => {
    const sent = await store(), received = await store()
    let calls = 0, drop = mode === 'retained', missing = false, active = true
    const legacy = frame()
    const message = { messageId: 'message-a', sender: { kind: 'human', sessionId: null }, senderSessionId: null,
      target: { nodeId: 'node-b', sessionId: 'session-b' }, priority: 'steer', content: 'Synthetic direct message',
      createdAt: 1, revision: 0, mailboxSequence: 0, stateVersion: 0, operationId: 'operation-a', messageClass: 'handoff' }
    const envelope = { deliveryId: 'delivery-a', sourceNodeId: 'node-a', message }
    const payload = { operationId: 'operation-a', target: message.target, messageClass: 'handoff', content: message.content,
      delivery: { ...envelope, digest: digest(envelope) } }
    const request = decodeRequest({ ...legacy, method: 'messages.send', payload, payloadDigest: digest(payload),
      delegation: { ...legacy.delegation, requestDigest: digest(payload) } })
    const executor = provider(async (input) => {
      calls++
      return decodeResponse({ ...input, status: 'ok', result: { messageId: 'message-a', operationId: 'operation-a',
        deliveryOutcome: 'rejected', messageState: 'rejected', pending: false, reason: 'unavailable', candidates: [] } }, input)
    })
    const receiver = new NodeReceiver('node-b', 'node-a', received, () => executor)
    const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-b', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
    const listener = await listenLoopback(0, limits, () => auth, async (value) => {
      if (object(value) && value.type === 'hello') return { version: NODE_LINK_VERSION, nodeId: 'node-b', epoch: auth.epoch,
        nonce: value.nonce, status: await executor.status() }
      if (object(value) && value.type === 'receipt') {
        if (missing && mode === 'stopped-after-query') active = false
        return missing ? { state: 'missing' } : { state: 'pending' }
      }
      if (drop) { drop = false; throw new Error('Lost before receiver admission') }
      return receiver.receive(decodeRequest(value))
    })
    cleanups.push(() => listener.close())
    const router = new NodeRouter({ ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', directory: 'unused',
      listenPort: 0, peerPort: listener.port, staleMs: 10000 }, auth, sent, () => true)
    const recovery = { reconcile: mode !== 'retained', active: () => active }
    expect(await router.handshake()).toBe(true)
    expect(await router.route(request, recovery)).toMatchObject({ error: { effectState: 'unknown' } })
    router.disconnect()
    expect(await router.route(request, recovery)).toMatchObject({ error: { effectState: 'unknown' } })
    expect(await router.handshake()).toBe(true)
    expect(await router.route(request, recovery)).toMatchObject({ error: { effectState: 'unknown' } })
    expect(calls).toBe(0)
    missing = true
    if (mode === 'stopped-after-query') {
      expect(await router.route(request, recovery)).toMatchObject({ error: { effectState: 'unknown' } })
      expect(calls).toBe(0)
    } else {
      expect(await router.route(request, recovery)).toMatchObject({ status: 'ok', result: { messageId: 'message-a' } })
      expect(calls).toBe(1)
    }
  })

test('preserves complete legacy refusal bytes and payload digest without work-chain capability', async () => {
  const request = decodeRequest({ ...frame(), deadline: '2099-01-01T00:00:00.000Z',
    delegation: { ...frame().delegation, expiresAt: '2099-01-01T00:00:00.000Z' } })
  const receiver = new NodeReceiver('node-b', 'node-a', await store(), () => undefined)
  const expected = '{"version":"node-link/v1","requestId":"request-a","operationId":"operation-a",'
    + '"sourceNodeId":"node-a","targetNodeId":"node-b","method":"seat.wake","status":"unavailable",'
    + '"error":{"code":"cross-node-unsupported","reason":"cross-node-unsupported","retryable":false,'
    + '"effectState":"none","operationId":"operation-a","targetNodeId":"node-b"}}'
  expect(JSON.stringify(await receiver.receive(request))).toBe(expected)
  expect(request.payloadDigest).toBe('05ee3f8188520a02cce05895fe4c9bd29afb961e621cdbcee0970830194d2db2')
  const router = new NodeRouter({ ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
    directory: 'unused', listenPort: 0, peerPort: 1, staleMs: 10 },
  { credential: randomBytes(32).toString('hex'), epoch: 'epoch-b', sourceNodeId: 'node-a', targetNodeId: 'node-b' },
  await store(), () => false)
  expect(JSON.stringify(await router.route(request))).toBe(expected.replaceAll('cross-node-unsupported', 'node-tunnel-disconnected')
    .replace('"retryable":false', '"retryable":true'))
})

test('old peers accept the seven-method hello and expose readable missing revision capability', async () => {
  const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen', 'source.prepareOpening',
    'source.checkAdmission', 'source.deliverCallback', 'chain.operation'] as const
  const legacy: ChainCapability = { capability: 'node-work-chain/v1', maxFrameBytes: 65536, methods }
  let observed: ChainCapability | undefined, mode = 'legacy', available = true
  const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-b', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
  const executor = provider(async request => failure(request, 'cross-node-unsupported'))
  const listener = await listenLoopback(0, limits, () => auth, async (value) => {
    if (!object(value) || value.type !== 'hello' || typeof value.nonce !== 'string') throw new Error('Expected hello')
    expect(decodeChainCapability(value.chain)).toEqual(legacy)
    expect(value.seatDefinitionRevision).toBe('seat-definition-revision/v1')
    if (mode === 'refused') return helloRefusal('node-b', value.nonce, auth.epoch,
      'node-protocol-mismatch', 'protocol-version-mismatch', 'The peer protocol version is not supported.')
    return { version: NODE_LINK_VERSION, nodeId: 'node-b', epoch: auth.epoch, nonce: value.nonce,
      status: await executor.status(), chain: legacy, ...(mode === 'invalid' ? { seatDefinitionRevision: 'future' } : {}) }
  })
  cleanups.push(() => listener.close())
  const router = new NodeRouter({ ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
    directory: 'unused', listenPort: 0, peerPort: listener.port, staleMs: 60000 }, auth, await store(), () => available,
  { capability: () => ({ ...legacy, methods: [...methods, 'seat.definitionRevision'] }), observe: (value) => { observed = value } })
  expect(await router.handshake()).toBe(true)
  expect(observed).toEqual(legacy)
  expect(await router.status()).toMatchObject([{ reachable: true, capabilities: ['node-link/v1', 'node-work-chain/v1'],
    safeReason: 'peer-capability-missing: The peer does not advertise seat-definition-revision/v1; exact revision reads are unavailable.' }])
  mode = 'refused'
  expect(await router.handshake()).toBe(false)
  expect(await router.status()).toMatchObject([{ reachable: false,
    safeReason: 'protocol-version-mismatch: The peer protocol version is not supported.' }])
  mode = 'invalid'
  expect(await router.handshake()).toBe(false)
  expect(await router.status()).toMatchObject([{ reachable: false,
    safeReason: 'authentication-unconfirmed: The peer handshake could not be authenticated or decoded; exact revision reads are unavailable.' }])
  available = false
  expect(await router.handshake()).toBe(false)
  expect(await router.status()).toMatchObject([{ reachable: false,
    safeReason: 'tunnel-disconnected: The peer transport is unavailable; exact revision reads are unavailable.' }])
})

test('rejects mismatched identities, digests, multiple hops and response correlation', () => {
  const valid = frame()
  expect(() => decodeRequest({ ...valid, hop: 2 })).toThrow()
  expect(() => decodeRequest({ ...valid, payloadDigest: digest({}) })).toThrow()
  expect(() => decodeRequest({ ...valid, delegation: { ...valid.delegation, targetNodeId: 'other' } })).toThrow()
  expect(() => decodeResponse({ ...failure(valid, 'cross-node-unsupported'), requestId: 'other' }, valid)).toThrow()
})
