/** Loader peers route six fixed methods; execution doubles do not claim real journal admission. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PosixPrivateFiles, OperationStore, listenLoopback, digest, object } from '@panedesk/dsh-host-admin'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import * as NodeLink from '../src/index.ts'
import { decodeRequest } from '../src/codec.ts'
import { failure, NodeReceiver } from '../src/receiver.ts'
import { NodeRouter } from '../src/router.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8,
  maxStoreBytes: 1048576, maxOperations: 100, staleMs: 20 }
const methods = ['seat.open', 'seat.openBatch', 'seat.renew', 'seat.close', 'seat.replace', 'seat.wake'] as const

test.each(methods)('reconciles %s after a lost response without executing twice', async (method) => {
  const root = await mkdtemp(join(tmpdir(), 'lost-response-'))
  const received = new OperationStore(new PosixPrivateFiles(join(root, 'received'), process.getuid!()), 1048576, 100)
  const sent = new OperationStore(new PosixPrivateFiles(join(root, 'sent'), process.getuid!()), 1048576, 100)
  let listener: Awaited<ReturnType<typeof listenLoopback>> | undefined
  try {
    await received.load(); await sent.load()
    const input = frame(method)
    let calls = 0, drop = true
    const executor: NodeLink.NodeLinkExecutor = { authorize: async () => true,
      execute: async (request) => { calls++; return failure(request, 'cross-node-unsupported') },
      status: async () => decodeSeatResult('seats/nodeStatus', { nodeId: 'node-b', nodeName: 'peer',
        engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) }
    const receiver = new NodeReceiver('node-b', 'node-a', received, () => executor)
    const auth = { credential: randomBytes(32).toString('hex'), epoch: randomUUID(), sourceNodeId: 'node-a', targetNodeId: 'node-b' }
    listener = await listenLoopback(0, limits, () => auth, async (value) => {
      if (object(value) && value.type === 'hello') return { version: NodeLink.NODE_LINK_VERSION, nodeId: 'node-b',
        epoch: auth.epoch, nonce: value.nonce, status: await executor.status() }
      if (object(value) && value.type === 'receipt') return received.query(JSON.stringify(['node-a', 'principal-a', input.operationId]))
      const result = await receiver.receive(decodeRequest(value))
      if (drop) { drop = false; throw new Error('Simulated response loss') }
      return result
    })
    const router = new NodeRouter({ ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer',
      directory: root, listenPort: 0, peerPort: listener.port }, auth, sent, () => true)
    expect(await router.handshake()).toBe(true)
    expect(await router.route(input)).toMatchObject({ error: { effectState: 'unknown' } })
    expect(await router.route(input)).toMatchObject({ error: { code: 'cross-node-unsupported' } })
    expect(calls).toBe(1)
  } finally { await listener?.close(); await received.close(); await sent.close(); await rm(root, { recursive: true, force: true }) }
})
function frame(method: typeof methods[number], suffix = '') {
  const operationId = `${method}${suffix}`, base = { operationId, nodeId: 'node-b' }
  const payload = method === 'seat.openBatch' ? { ...base, seats: ['seat-a'], origin: 'manual' }
    : method === 'seat.open' ? { ...base, seat: 'seat-a', origin: 'manual' }
      : method === 'seat.wake' ? { ...base, seat: 'seat-a' }
        : { ...base, sessionId: 'session-a', ...(method === 'seat.close' ? { expectedStateVersion: 1 } : {}) }
  const deadline = new Date(Date.now() + 60000).toISOString()
  return decodeRequest({ version: NodeLink.NODE_LINK_VERSION, requestId: randomUUID(), sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId, deadline, hop: 1, method, payload, payloadDigest: digest(payload),
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'authorization-a',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId, requestDigest: digest(payload), taskIds: [], expiresAt: deadline } })
}

test('routes every fixed seat method once through Loader peers and refuses changed, expired, narrowed or disconnected calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'six-methods-'))
  const contexts: Context[] = [], listeners: Awaited<ReturnType<typeof listenLoopback>>[] = []
  const counts = new Map<string, number>()
  let allowed = true
  const auth = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })
  try {
    for (const _node of [0, 1]) listeners.push(await listenLoopback(0, limits, auth, async () => ({})))
    const ports = listeners.map(listener => listener.port)
    for (const listener of listeners) await listener.close()
    listeners.length = 0
    const credentials = [auth(), auth()], nodes = ['node-a', 'node-b']
    for (const i of [0, 1]) {
      const nodeId = nodes[i]!, peerNodeId = nodes[1 - i]!, directory = join(root, nodeId)
      const files = new PosixPrivateFiles(directory, process.getuid!())
      await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
      await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
      const ctx = new Context()
      contexts.push(ctx)
      ctx.baseUrl = `${pathToFileURL(root).href}/`
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
      ctx.provide('nodeLinkExecutor', { authorize: async () => allowed, execute: async (request) => {
        counts.set(request.operationId, (counts.get(request.operationId) ?? 0) + 1)
        return failure(request, 'cross-node-unsupported')
      }, status: async () => decodeSeatResult('seats/nodeStatus', { nodeId, nodeName: nodeId,
        engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) })
      const profile = join(root, `${nodeId}.yml`)
      await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
        ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId, listenPort: ports[i], peerPort: ports[1 - i],
      } } }]))
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
      await ctx.loader.await()
    }
    await expect.poll(() => contexts[0]!.get('nodeRouter'), { timeout: 10000 }).toBeDefined()
    const router = contexts[0]!.get('nodeRouter')!
    await expect.poll(async () => (await router.status())[0]?.reachable, { timeout: 10000 }).toBe(true)
    for (const method of methods) {
      const request = frame(method)
      const first = await router.route(request)
      expect(first).toMatchObject({ method, error: { code: 'cross-node-unsupported' } })
      expect(await router.route({ ...request, requestId: randomUUID() as typeof request.requestId }))
        .toMatchObject({ method, error: { code: 'cross-node-unsupported' } })
      expect(counts.get(request.operationId)).toBe(1)
      const payload = { ...request.payload, ...('seat' in request.payload ? { seat: 'seat-b' }
          : 'seats' in request.payload ? { seats: ['seat-b'] } : { sessionId: 'session-b' }) }, fingerprint = digest(payload)
      const changed = decodeRequest({ ...request, payload, payloadDigest: fingerprint,
        delegation: { ...request.delegation, requestDigest: fingerprint } })
      expect(await router.route(changed)).toMatchObject({ error: { code: 'node-operation-conflict' } })
      await expect(router.route({ ...request, sourceNodeId: request.targetNodeId })).rejects.toThrow('Node frame rejected')
      const expired = frame(method, '-expired')
      expect(await router.route({ ...expired, delegation: { ...expired.delegation, expiresAt: new Date(0).toISOString() } }))
        .toMatchObject({ error: { code: 'node-deadline-exceeded' } })
      allowed = false
      expect(await router.route(frame(method, '-narrowed'))).toMatchObject({ error: { code: 'node-delegation-rejected' } })
      allowed = true
    }
    await contexts[1]!.fiber.dispose()
    await expect.poll(async () => (await router.status())[0]?.safeReason, { timeout: 10000 }).toBe('node-tunnel-disconnected')
    for (const method of methods) expect(await router.route(frame(method, '-offline')))
      .toMatchObject({ error: { effectState: 'none', code: 'node-tunnel-disconnected' } })
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    for (const listener of listeners) await listener.close()
    await rm(root, { recursive: true, force: true })
  }
})
