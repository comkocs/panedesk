/** Two Loader nodes handshake bidirectionally through temporary loopback peers and unload. */
import { afterEach, expect, test, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { SubprocessRuntime, type SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PosixPrivateFiles, listenLoopback, object, digest, OperationStore } from '@panedesk/dsh-host-admin'
import * as NodeLink from '../src/index.ts'
import type { NodeLinkExecutor, NodeWireRequest } from '../src/index.ts'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import { NodeReceiver, failure } from '../src/receiver.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100, staleMs: 20 }

test('authenticates each Loader direction independently, aggregates reported status and unloads services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const auth = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })
  const reserveA = await listenLoopback(0, limits, auth, async () => ({}))
  const reserveB = await listenLoopback(0, limits, auth, async () => ({}))
  const ports = [reserveA.port, reserveB.port]
  await reserveA.close(); await reserveB.close()
  const nodes = ['node-a', 'node-b']
  const credentials = [auth(), auth()]
  const contexts: Context[] = []
  for (const i of [0, 1]) {
    const nodeId = nodes[i]!, peerNodeId = nodes[1 - i]!
    const directory = join(root, nodeId), files = new PosixPrivateFiles(directory, process.getuid!())
    await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
    await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
    const ctx = new Context()
    contexts.push(ctx)
    cleanups.push(() => ctx.fiber.dispose())
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
    ctx.provide('nodeLinkExecutor', { authorize: async () => true, execute: async request => failure(request, 'cross-node-unsupported'),
      status: async () => decodeSeatResult('seats/nodeStatus', { nodeId, nodeName: nodeId,
        engine: 'running', openEngineWindows: i + 1, limit: 4, readyAt: null }) })
    const profile = join(root, `${nodeId}.yml`)
    await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
      ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId, listenPort: ports[i], peerPort: ports[1 - i],
    } } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
  }
  for (const [i, ctx] of contexts.entries()) {
    await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0]?.status?.openEngineWindows, { timeout: 10000 }).toBe(2 - i)
  }
  await contexts[0]!.fiber.dispose()
  expect(contexts[0]!.get('nodeRouter')).toBeUndefined()
  await expect.poll(async () => (await contexts[1]!.get('nodeRouter')?.status())?.[0]?.reachable, { timeout: 10000 }).toBe(false)
  expect((await contexts[1]!.get('nodeRouter')?.status())?.[0]?.status?.openEngineWindows).toBe(1)
})

test('Loader node status retains the exhausted tunnel reason through health probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-exhausted-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!())
  for (const name of ['inbound', 'outbound']) await files.write(`${name}.json`, JSON.stringify({
    credential: randomBytes(32).toString('hex'), epoch: 'test', sourceNodeId: name === 'inbound' ? 'node-b' : 'node-a',
    targetNodeId: name === 'inbound' ? 'node-a' : 'node-b',
  }))
  const done = Promise.withResolvers<SubprocessOutcome>(), stderr = new PassThrough()
  const spawn = vi.fn(() => ({ stdin: undefined, stdout: undefined, stderr, control: undefined, collected: {},
    done: done.promise, terminate: () => { done.resolve({ exitCode: 0, signal: null }) },
    waitForExit: async () => { await done.promise; return true } }))
  class TestSubprocess extends SubprocessRuntime {
    resolveExecutable = async () => '/usr/bin/ssh'
    terminalEnvironment = async () => ({ platform: 'posix' as const })
    spawn = spawn
    spawnTerminal = async (): Promise<never> => { throw new Error('Not used') }
  }
  const ctx = new Context(), messages: string[] = []
  cleanups.push(() => ctx.fiber.dispose())
  ctx.logger.exporter({ export: (message) => { messages.push(String(message.args[0])) } })
  await ctx.plugin(TestSubprocess)
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
  const profile = join(root, 'node.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
    ...limits, directory: root, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', listenPort: 0, peerPort: 1,
    ssh: { alias: 'test-peer', cwd: root, remotePort: 1, remoteTargetPort: 1,
      graceMs: 100, keepAliveSeconds: 5, keepAliveCount: 2, retryMs: 100, maxRetries: 0 },
  } } }]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  await expect.poll(() => ctx.get('nodeRouter'), { timeout: 2000 }).toBeDefined()
  expect(spawn).toHaveBeenCalledOnce()
  stderr.write('Connection to 192.0.2.1 failed. Extra detail\n')
  done.resolve({ exitCode: 255, signal: null })
  await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0]?.safeReason, { timeout: 10000 })
    .toBe('SSH tunnel exhausted: exitCode=255 signal=none; Connection to <addr> failed. Link remains disconnected until host restart.')
  await new Promise(resolve => setTimeout(resolve, limits.staleMs * 3))
  expect((await ctx.get('nodeRouter')!.status())[0]).toMatchObject({ reachable: false,
    safeReason: 'SSH tunnel exhausted: exitCode=255 signal=none; Connection to <addr> failed. Link remains disconnected until host restart.' })
  expect(spawn).toHaveBeenCalledOnce()
  expect(messages.filter(message => message.startsWith('ssh-tunnel exhausted '))).toHaveLength(1)
})

test('rebuilds one exhausted tunnel without restarting the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-rebuild-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!())
  const outbound = { credential: randomBytes(32).toString('hex'), epoch: 'test', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
  await files.write('outbound.json', JSON.stringify(outbound))
  await files.write('inbound.json', JSON.stringify({ ...outbound, credential: randomBytes(32).toString('hex'),
    sourceNodeId: 'node-b', targetNodeId: 'node-a' }))
  let authenticated = false
  const peer = await listenLoopback(0, limits, () => outbound, async (value) => {
    if (!authenticated || !object(value) || value.type !== 'hello') throw new Error('Peer handshake unavailable')
    return { version: NodeLink.NODE_LINK_VERSION, nodeId: 'node-b', epoch: outbound.epoch, nonce: value.nonce,
      status: { nodeId: 'node-b', nodeName: 'peer', engine: 'running', openEngineWindows: 2, limit: 4, readyAt: null } }
  })
  cleanups.push(() => peer.close())
  const exits: ReturnType<typeof Promise.withResolvers<SubprocessOutcome>>[] = []
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => {
    const done = Promise.withResolvers<SubprocessOutcome>(), stderr = new PassThrough()
    exits.push(done)
    return { stdin: undefined, stdout: undefined, stderr, control: undefined, collected: {}, done: done.promise,
      terminate: () => { done.resolve({ exitCode: 0, signal: null }) },
      waitForExit: async () => { await done.promise; return true } }
  })
  class RebuildSubprocess extends SubprocessRuntime {
    resolveExecutable = async () => '/usr/bin/ssh'
    terminalEnvironment = async () => ({ platform: 'posix' as const })
    spawn = spawn
    spawnTerminal = async (): Promise<never> => { throw new Error('Not used') }
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(RebuildSubprocess)
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
  const profile = join(root, 'node.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
    ...limits, directory: root, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', listenPort: 0, peerPort: peer.port,
    ssh: { alias: 'test-peer', cwd: root, remotePort: 1, remoteTargetPort: 1,
      graceMs: 100, keepAliveSeconds: 5, keepAliveCount: 2, retryMs: 100, maxRetries: 0 },
  } } }]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  await expect.poll(() => ctx.get('hostAdminTransport'), { timeout: 2000 }).toBeDefined()
  exits[0]!.resolve({ exitCode: 255, signal: null })
  await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0]?.safeReason, { timeout: 10000 })
    .toContain('SSH tunnel exhausted')
  expect(spawn).toHaveBeenCalledOnce()
  const first = ctx.get('hostAdminTransport')!.rebuildTransport()
  const second = ctx.get('hostAdminTransport')!.rebuildTransport()
  await expect(first).resolves.toEqual({ status: 'rebuilt' })
  await expect(second).resolves.toEqual({ status: 'rebuilt' })
  expect(spawn).toHaveBeenCalledTimes(2)
  const restarted = spawn.mock.calls[1]![0].argv as string[]
  expect(restarted).toContain('-N')
  expect(restarted).not.toContain('-F')
  expect((await ctx.get('nodeRouter')!.status())[0]?.reachable).toBe(false)
  authenticated = true
  await expect.poll(async () => (await ctx.get('nodeRouter')!.status())[0]?.reachable, { timeout: 10000 }).toBe(true)
  expect((await ctx.get('nodeRouter')!.status())[0]?.status?.openEngineWindows).toBe(2)
})

test('leaves node services unregistered without configuration', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(NodeLink, {})
  expect(ctx.get('nodeRouter')).toBeUndefined()
})

test('rebuild after exhaustion replays nothing settled and delivers each unresolved item exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-rebuild-delivery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const peerRoot = await mkdtemp(join(tmpdir(), 'node-rebuild-peer-'))
  cleanups.push(() => rm(peerRoot, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!())
  const outbound = { credential: randomBytes(32).toString('hex'), epoch: 'test', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
  await files.write('outbound.json', JSON.stringify(outbound))
  await files.write('inbound.json', JSON.stringify({ ...outbound, credential: randomBytes(32).toString('hex'),
    sourceNodeId: 'node-b', targetNodeId: 'node-a' }))
  const received = new OperationStore(new PosixPrivateFiles(peerRoot, process.getuid!()),
    limits.maxStoreBytes, limits.maxOperations)
  await received.load()
  const executed = new Map<string, number>()
  const dropResponse = new Set<string>()
  const status = async () => decodeSeatResult('seats/nodeStatus', { nodeId: 'node-b', nodeName: 'peer',
    engine: 'running', openEngineWindows: 2, limit: 4, readyAt: null })
  const executor: NodeLinkExecutor = { authorize: async () => true, status,
    execute: async (input) => {
      executed.set(input.operationId, (executed.get(input.operationId) ?? 0) + 1)
      return decodeResponse({ ...input, status: 'ok', result: { messageId: 'message-a', operationId: input.operationId,
        deliveryOutcome: 'rejected', messageState: 'rejected', pending: false, reason: 'unavailable', candidates: [] } }, input)
    } }
  const receiver = new NodeReceiver('node-b', 'node-a', received, () => executor)
  let authenticated = false
  const peer = await listenLoopback(0, limits, () => outbound, async (value) => {
    if (object(value) && value.type === 'hello') {
      if (!authenticated) throw new Error('Peer handshake unavailable')
      return { version: NodeLink.NODE_LINK_VERSION, nodeId: 'node-b', epoch: outbound.epoch, nonce: value.nonce,
        status: await status(), seatMessages: 'seat-messages/v1' }
    }
    if (object(value) && value.type === 'receipt') {
      const request = decodeRequest(value.request)
      return received.query(JSON.stringify([request.sourceNodeId, request.delegation.principalId, request.operationId]),
        digest({ method: request.method, payload: request.payload, principalId: request.delegation.principalId,
          seat: request.delegation.seat ?? null, sessionId: request.delegation.sessionId ?? null, taskIds: request.delegation.taskIds }))
    }
    const result = await receiver.receive(decodeRequest(value))
    if (object(value) && dropResponse.has(String(value.operationId))) throw new Error('Simulated response loss')
    return result
  })
  cleanups.push(() => peer.close())
  const messageRequest = (operationId: string, requestId: string): NodeWireRequest => {
    const message = { messageId: 'message-a', sender: { kind: 'human' as const, sessionId: null }, senderSessionId: null,
      target: { nodeId: 'node-b', sessionId: 'session-b' }, priority: 'steer' as const, content: 'Synthetic direct message',
      createdAt: 1, revision: 0, mailboxSequence: 0, stateVersion: 0, operationId, messageClass: 'handoff' as const }
    const envelope = { deliveryId: `delivery-${operationId}`, sourceNodeId: 'node-a', message }
    const payload = { operationId, target: message.target, messageClass: 'handoff', content: message.content,
      delivery: { ...envelope, digest: digest(envelope) } }
    return decodeRequest({ version: NodeLink.NODE_LINK_VERSION, method: 'messages.send', requestId,
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId,
      deadline: new Date(Date.now() + 60000).toISOString(), hop: 1, payload, payloadDigest: digest(payload),
      delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'grant-a',
        sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId, requestDigest: digest(payload), taskIds: [],
        expiresAt: new Date(Date.now() + 60000).toISOString() } })
  }
  const exits: ReturnType<typeof Promise.withResolvers<SubprocessOutcome>>[] = []
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => {
    const done = Promise.withResolvers<SubprocessOutcome>(), stderr = new PassThrough()
    exits.push(done)
    return { stdin: undefined, stdout: undefined, stderr, control: undefined, collected: {}, done: done.promise,
      terminate: () => { done.resolve({ exitCode: 0, signal: null }) },
      waitForExit: async () => { await done.promise; return true } }
  })
  class RebuildSubprocess extends SubprocessRuntime {
    resolveExecutable = async () => '/usr/bin/ssh'
    terminalEnvironment = async () => ({ platform: 'posix' as const })
    spawn = spawn
    spawnTerminal = async (): Promise<never> => { throw new Error('Not used') }
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(RebuildSubprocess)
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
  const profile = join(root, 'node.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
    ...limits, directory: root, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', listenPort: 0, peerPort: peer.port,
    ssh: { alias: 'test-peer', cwd: root, remotePort: 1, remoteTargetPort: 1,
      graceMs: 100, keepAliveSeconds: 5, keepAliveCount: 2, retryMs: 100, maxRetries: 0 },
  } } }]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  await expect.poll(() => ctx.get('hostAdminTransport') !== undefined && ctx.get('nodeRouter') !== undefined,
    { timeout: 5000 }).toBe(true)
  const transport = ctx.get('hostAdminTransport')!, routerService = ctx.get('nodeRouter')!
  authenticated = true
  await expect.poll(async () => (await routerService.status())[0]?.reachable, { timeout: 10000 }).toBe(true)
  expect(await routerService.route(messageRequest('settled-op', 'request-settled')))
    .toMatchObject({ status: 'ok', result: { operationId: 'settled-op' } })
  expect(executed.get('settled-op')).toBe(1)
  dropResponse.add('inflight-op')
  expect(await routerService.route(messageRequest('inflight-op', 'request-inflight')))
    .toMatchObject({ status: 'uncertain', error: { code: 'node-outcome-unknown', effectState: 'unknown' } })
  expect(executed.get('inflight-op')).toBe(1)
  exits[0]!.resolve({ exitCode: 255, signal: null })
  await expect.poll(async () => (await routerService.status())[0]?.safeReason, { timeout: 10000 })
    .toContain('SSH tunnel exhausted')
  expect((await routerService.status())[0]?.reachable).toBe(false)
  expect(spawn).toHaveBeenCalledOnce()
  expect(await routerService.route(messageRequest('queued-op', 'request-queued')))
    .toMatchObject({ status: 'unavailable', error: { code: 'node-tunnel-disconnected', effectState: 'none' } })
  expect(executed.has('queued-op')).toBe(false)
  const first = transport.rebuildTransport(), second = transport.rebuildTransport()
  await expect(first).resolves.toEqual({ status: 'rebuilt' })
  await expect(second).resolves.toEqual({ status: 'rebuilt' })
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(ctx.get('hostAdminTransport')).toBe(transport)
  expect(ctx.get('nodeRouter')).toBe(routerService)
  await expect.poll(async () => (await routerService.status())[0]?.reachable, { timeout: 10000 }).toBe(true)
  expect(await routerService.route(messageRequest('inflight-op', 'request-inflight-retry')))
    .toMatchObject({ status: 'ok', result: { operationId: 'inflight-op' } })
  expect(executed.get('inflight-op')).toBe(1)
  expect(await routerService.route(messageRequest('settled-op', 'request-settled-retry')))
    .toMatchObject({ status: 'ok', result: { operationId: 'settled-op' } })
  expect(executed.get('settled-op')).toBe(1)
  expect(await routerService.route(messageRequest('queued-op', 'request-queued-retry')))
    .toMatchObject({ status: 'ok', result: { operationId: 'queued-op' } })
  expect(executed.get('queued-op')).toBe(1)
  await ctx.fiber.dispose()
  await expect(transport.rebuildTransport()).resolves.toEqual({ status: 'unavailable' })
  expect(spawn).toHaveBeenCalledTimes(2)
}, 30000)
