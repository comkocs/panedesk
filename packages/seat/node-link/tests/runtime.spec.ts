/** Two Loader nodes handshake bidirectionally through temporary loopback peers and unload. */
import { afterEach, expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PosixPrivateFiles, listenLoopback } from '@panedesk/dsh-host-admin'
import * as NodeLink from '../src/index.ts'
import { decodeSeatResult } from '@panedesk/dsh-sdk-protocol'
import { failure } from '../src/receiver.ts'

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
    await expect.poll(async () => (await ctx.get('nodeRouter')?.status())?.[0]?.status?.openEngineWindows).toBe(2 - i)
  }
  await contexts[0]!.fiber.dispose()
  expect(contexts[0]!.get('nodeRouter')).toBeUndefined()
  await expect.poll(async () => (await contexts[1]!.get('nodeRouter')?.status())?.[0]?.reachable).toBe(false)
  expect((await contexts[1]!.get('nodeRouter')?.status())?.[0]?.status?.openEngineWindows).toBe(1)
})

test('leaves node services unregistered without configuration', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(NodeLink, {})
  expect(ctx.get('nodeRouter')).toBeUndefined()
})
