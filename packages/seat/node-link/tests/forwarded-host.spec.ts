/** TCP forwards preserve HTTP authority while paired runtimes negotiate recovered capabilities. */
import { afterEach, expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PosixPrivateFiles, listenLoopback } from '@panedesk/dsh-host-admin'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import * as NodeLink from '../src/index.ts'
import { failure } from '../src/receiver.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8,
  maxStoreBytes: 65536, maxOperations: 20, staleMs: 200 }
const authentication = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })

async function forward(target: number) {
  const sockets = new Set<Socket>()
  const server = createServer((incoming) => {
    const outgoing = connect(target, '127.0.0.1')
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('error', () => { incoming.destroy(); outgoing.destroy() })
    }
    incoming.pipe(outgoing).pipe(incoming)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy()
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Forward unavailable')
  return address.port
}

async function pair(forwarded: boolean, allowForward = forwarded) {
  const root = await mkdtemp(join(tmpdir(), 'node-forward-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const credentials = [authentication(), authentication()]
  const reserves = []
  for (const auth of credentials) {
    const listener = await listenLoopback(0, limits, () => auth, async () => ({}))
    reserves.push(listener)
    cleanups.push(() => listener.close())
  }
  const ports = reserves.map(listener => listener.port)
  const entries = forwarded ? [await forward(ports[0]!), await forward(ports[1]!)] : ports
  await Promise.all(reserves.map(listener => listener.close()))
  cleanups.splice(1, reserves.length)
  const contexts: Context[] = [], logs: string[][] = [[], []]
  for (const i of [0, 1]) {
    const nodeId = i === 0 ? 'node-a' : 'node-b', peerNodeId = i === 0 ? 'node-b' : 'node-a'
    const directory = join(root, nodeId), files = new PosixPrivateFiles(directory, process.getuid!())
    await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
    await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
    const ctx = new Context()
    contexts.push(ctx); cleanups.push(() => ctx.fiber.dispose())
    ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs[i]!.push(String(message.args[0])) } })
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, nodeLink: NodeLink })
    ctx.provide('nodeLinkExecutor', { authorize: async () => false,
      execute: async value => failure(value, 'cross-node-unsupported'),
      status: async () => decodeSeatResult('seats/nodeStatus', { nodeId, nodeName: nodeId,
        engine: 'running', openEngineWindows: 0, limit: 4, readyAt: null }) })
    ctx.provide('nodeWorkChain', { maxControlPending: 2,
      policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
        authorize: async () => { throw new Error('Unexpected business request') } },
      local: { methods: [], ready: async () => {} } })
    const profile = join(root, `${nodeId}.yml`)
    await writeFile(profile, JSON.stringify([{ name: 'cordis:nodeLink', config: { runtime: {
      ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId, listenPort: ports[i], peerPort: entries[1 - i],
      ...(allowForward ? { forwardedHosts: [`127.0.0.1:${entries[i]}`] } : {}),
    } } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
  }
  return { contexts, ports, entries, credentials, logs }
}

async function hello(port: number, host: string, auth: ReturnType<typeof authentication>) {
  return new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/rpc', agent: false,
      headers: { host, 'content-type': 'application/json', authorization: auth.credential, 'x-rpc-epoch': auth.epoch },
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += String(chunk) })
      response.on('error', reject)
      response.on('end', () => { resolve({ status: response.statusCode, text }) })
    })
    req.on('error', reject)
    req.end(JSON.stringify({ type: 'hello', version: NodeLink.NODE_LINK_VERSION,
      sourceNodeId: 'node-b', targetNodeId: 'node-a', nonce: randomUUID() }))
  })
}

test.each([
  ['different-port TCP forwards', true],
  ['same-port direct topology without configuration', false],
] as const)('negotiates both runtimes through %s', async (_name, forwarded) => {
  const { contexts, ports, entries } = await pair(forwarded)
  expect(entries[0] === ports[0]).toBe(!forwarded)
  expect(entries[1] === ports[1]).toBe(!forwarded)
  for (const ctx of contexts) {
    await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0], { timeout: 10000 }).toMatchObject({
      reachable: true, linkState: 'connected', capabilities: ['node-link/v1', 'node-work-chain/v1'], safeReason: null,
    })
  }
})

test('rejects foreign hosts and unconfigured ports on a forwarded node listener', async () => {
  const { contexts, ports, entries, credentials } = await pair(true)
  await expect.poll(() => contexts[0]!.get('nodeRouter'), { timeout: 10000 }).toBeDefined()
  const port = entries[0]!, auth = credentials[0]!
  expect((await hello(port, `browser.invalid:${port}`, auth)).status).toBe(403)
  expect((await hello(port, `127.0.0.1:${entries[1]}`, auth)).status).toBe(403)
  expect((await hello(port, `localhost:${port}`, auth)).status).toBe(403)
  expect((await hello(port, `127.0.0.1:${port}`, auth)).status).toBe(200)
  expect((await hello(port, `127.0.0.1:${ports[0]}`, auth)).status).toBe(200)
})

test('rejects unlisted forwards with a bounded hello reason, one log per refusal and sender status', async () => {
  const { contexts, ports, entries, credentials, logs } = await pair(true, false)
  for (const ctx of contexts) {
    await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0], { timeout: 10000 }).toMatchObject({
      reachable: false, capabilities: [], safeReason: 'host-mismatch',
    })
  }
  // Disposal stops the sender's periodic probes and drains any handshake already in flight.
  await contexts[1]!.fiber.dispose()
  const before = logs[0]!.length
  const response = await hello(entries[0]!, `127.0.0.1:${entries[0]}`, credentials[0]!)
  expect(response.status).toBe(403)
  expect(JSON.parse(response.text)).toEqual({ code: 'host-mismatch', expectedPort: ports[0], actualPort: entries[0] })
  expect(logs[0]!.slice(before)).toEqual([`host-mismatch expectedPort=${ports[0]} actualPort=${entries[0]}`])
  for (const i of [0, 1]) {
    expect(logs[i]).toContain(`host-mismatch expectedPort=${ports[i]} actualPort=${entries[i]}`)
  }
})

test.each(['*', '*:1234', '127.0.0.1:*', '127.0.0.1:1-9', 'browser.invalid:1234',
  '127.0.0.1', '127.0.0.1:', '127.0.0.1:0', '127.0.0.1:65536', 'localhost:0123', '[::1]'])
('rejects invalid forwarding authority %s during configuration validation', (authority) => {
  expect(() => NodeLink.Config({ runtime: { ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'node-b',
    directory: '/unused', listenPort: 0, peerPort: 1234, forwardedHosts: [authority] } })).toThrow()
})
