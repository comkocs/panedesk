/** Node doubles exercise durable retries, lost responses and identity checks without real SSH connections. */
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { OperationStore, PosixPrivateFiles, digest, listenLoopback, object } from '@panedesk/dsh-host-admin'
import { NODE_LINK_VERSION, type NodeLinkRuntimeConfig, type NodeWireRequest, type NodeLinkExecutor } from '../src/index.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { NodeReceiver, failure } from '../src/receiver.ts'
import { NodeRouter } from '../src/router.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100 }
async function store() {
  const root = await mkdtemp(join(process.env.TEST_RESOURCE_ROOT!, 'node-test-'))
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

test('rejects mismatched identities, digests, multiple hops and response correlation', () => {
  const valid = frame()
  expect(() => decodeRequest({ ...valid, hop: 2 })).toThrow()
  expect(() => decodeRequest({ ...valid, payloadDigest: digest({}) })).toThrow()
  expect(() => decodeRequest({ ...valid, delegation: { ...valid.delegation, targetNodeId: 'other' } })).toThrow()
  expect(() => decodeResponse({ ...failure(valid, 'cross-node-unsupported'), requestId: 'other' }, valid)).toThrow()
})
