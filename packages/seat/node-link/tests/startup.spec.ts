/** Windows node startup observes provider visibility and Cordis failure ownership. */
import { afterEach, expect, test, vi } from 'vitest'
import { Context, FiberState } from '@panedesk/cordis'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PosixPrivateFiles, type PrivateFiles } from '@panedesk/dsh-host-admin'
import * as NodeLink from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const runtime: NodeLink.NodeLinkRuntimeConfig = { directory: 'C:\\private', nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'node-b',
  listenPort: 0, peerPort: 1, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8,
  maxStoreBytes: 65536, maxOperations: 100, staleMs: 60000 }
function start(ctx: Context, config: NodeLink.Config = { runtime }) {
  return ctx.plugin({ name: NodeLink.name, apply(owner: Context) {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try { return NodeLink.apply(owner, config) }
    finally { Object.defineProperty(process, 'platform', platform) }
  } })
}
function context() {
  const ctx = new Context(), logs: string[] = []
  ctx.logger.exporter({ export(message) { logs.push(String(message.args[0])) } })
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, logs }
}
function fixture() {
  const values = new Map<string, string>([
    ['inbound.json', JSON.stringify({ sourceNodeId: 'node-b', targetNodeId: 'node-a', epoch: randomUUID(), credential: randomBytes(32).toString('hex') })],
    ['outbound.json', JSON.stringify({ sourceNodeId: 'node-a', targetNodeId: 'node-b', epoch: randomUUID(), credential: randomBytes(32).toString('hex') })],
  ])
  const prepare = vi.fn(async () => {}), unlock = vi.fn(async () => {})
  const read = vi.fn(async (name: string) => values.get(name) ?? null)
  const files: PrivateFiles = { prepare, read, write: async (name, content) => { values.set(name, content) },
    remove: async (name) => { values.delete(name) }, lock: async () => unlock }
  const factory = vi.fn(() => files)
  return { factory, prepare, read, unlock }
}

test('waits for a late active Windows node factory before reading directional credentials', async () => {
  const { ctx, logs } = context(), f = fixture(), fiber = start(ctx)
  await vi.waitFor(() => { expect(fiber.state).toBe(FiberState.LOADING) })
  expect(ctx.get('nodeRouter')).toBeUndefined()
  let release!: () => void
  const loading = new Promise<void>((resolve) => { release = resolve })
  const provider = ctx.plugin(async (owner) => { owner.provide('nodeLinkFiles', f.factory); await loading })
  await vi.waitFor(() => { expect(ctx.get('nodeLinkFiles', false)).toBeDefined() })
  expect(ctx.get('nodeLinkFiles')).toBeUndefined()
  expect(f.factory).not.toHaveBeenCalled()
  release(); await provider; await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('nodeRouter')).toBeDefined()
  expect(f.read.mock.calls.map(([name]) => name)).toContain('inbound.json')
  expect(f.read.mock.calls.map(([name]) => name)).toContain('outbound.json')
  expect(logs).toEqual([])
  await fiber.dispose()
  expect(ctx.get('nodeRouter')).toBeUndefined()
  expect(f.unlock).toHaveBeenCalledTimes(1)
})

test.each(['factory-first', 'composition-first', 'replacement-failure'])('replaces a waiting Windows attachment after provider activation: %s', async (order) => {
  const { ctx, logs } = context(), f = fixture(), fiber = start(ctx)
  if (order === 'replacement-failure') f.prepare.mockRejectedValue(new Error('Private ACL rights rejected'))
  await vi.waitFor(() => {
    expect([...ctx.registry.values()].some(entry => entry.name === 'node-link-attachment'
      && [...entry.fibers].some(child => child.state === FiberState.LOADING))).toBe(true)
  })
  const services: NodeLink.ChainServices = { maxControlPending: 2,
    policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      authorize: async () => { throw new Error('Unexpected authorization') } },
    local: { methods: [], ready: async () => {} } }
  const provider = ctx.plugin((owner) => {
    if (order === 'factory-first') owner.provide('nodeLinkFiles', f.factory)
    owner.provide('nodeWorkChain', services)
    if (order !== 'factory-first') owner.provide('nodeLinkFiles', f.factory)
  })
  await provider
  let failure: unknown
  try { await fiber } catch (error) { failure = error }
  if (order === 'replacement-failure') {
    expect(failure instanceof Error ? failure.message : failure).toBe('Private ACL rights rejected')
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(ctx.get('nodeRouter')).toBeUndefined()
    expect(logs.some(line => line.includes('Private ACL rights rejected'))).toBe(true)
    expect(logs.some(line => line.includes('inactive context'))).toBe(false)
    return
  }
  expect(failure instanceof Error ? failure.message : failure).toBeUndefined()
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('nodeRouter')).toBeDefined()
  expect(ctx.get('nodeWorkChainRouter')).toBeDefined()
  expect(logs).toEqual([])
  await fiber.dispose()
  expect(ctx.get('nodeRouter')).toBeUndefined()
  expect(ctx.get('nodeWorkChainRouter')).toBeUndefined()
})

test('drains a disposed Windows attachment before replacing its prepared resources', async () => {
  const { ctx, logs } = context(), f = fixture()
  let release!: () => void
  const preparing = new Promise<void>((resolve) => { release = resolve })
  f.prepare.mockImplementationOnce(() => preparing)
  ctx.provide('nodeLinkFiles', f.factory)
  const fiber = start(ctx)
  await vi.waitFor(() => { expect(f.prepare).toHaveBeenCalledTimes(1) })
  ctx.provide('nodeWorkChain', { maxControlPending: 2,
    policy: { ready: async () => {}, expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      authorize: async () => { throw new Error('Unexpected authorization') } },
    local: { methods: [], ready: async () => {} } })
  release()
  await fiber
  expect(ctx.get('nodeRouter')).toBeDefined()
  expect(ctx.get('nodeWorkChainRouter')).toBeDefined()
  expect(f.unlock).toHaveBeenCalledTimes(1)
  expect(logs).toEqual([])
  await fiber.dispose()
  expect(f.unlock).toHaveBeenCalledTimes(2)
})

test('fails visibly when the Windows node private-file factory is missing', async () => {
  const { ctx, logs } = context(), fiber = start(ctx)
  await expect(fiber.await()).rejects.toThrow('nodeLinkFiles unavailable')
  expect(fiber.state).toBe(FiberState.FAILED)
  expect(logs.some(line => line.includes('nodeLinkFiles unavailable'))).toBe(true)
  expect(ctx.get('nodeRouter')).toBeUndefined()
})

test('reports Windows node preparation failure through the startup error chain', async () => {
  const { ctx, logs } = context(), f = fixture()
  f.prepare.mockRejectedValue(new Error('Private ACL rights rejected'))
  ctx.provide('nodeLinkFiles', f.factory)
  const fiber = start(ctx)
  await expect(fiber.await()).rejects.toThrow('Private ACL rights rejected')
  expect(fiber.state).toBe(FiberState.FAILED)
  expect(logs.some(line => line.includes('Private ACL rights rejected'))).toBe(true)
  expect(ctx.get('nodeRouter')).toBeUndefined()
})

test('keeps empty Windows node configuration inert without waiting for a factory', async () => {
  const { ctx, logs } = context(), fiber = start(ctx, {})
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('nodeRouter')).toBeUndefined()
  expect(logs).toEqual([])
})

test('keeps POSIX node startup independent of a Windows factory', async () => {
  const root = await mkdtemp(join(process.cwd(), '.node-posix-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!())
  for (const [direction, sourceNodeId, targetNodeId] of [
    ['inbound', 'node-b', 'node-a'], ['outbound', 'node-a', 'node-b'],
  ]) await files.write(`${direction}.json`, JSON.stringify({ sourceNodeId, targetNodeId,
    epoch: randomUUID(), credential: randomBytes(32).toString('hex') }))
  const { ctx, logs } = context(), fiber = ctx.plugin(NodeLink, { runtime: { ...runtime, directory: root } })
  await fiber
  await expect.poll(() => ctx.get('nodeRouter')).toBeDefined()
  expect(await readdir(root)).toContain('owner.lock')
  expect(logs).toEqual([])
  await fiber.dispose()
  expect(await readdir(root)).not.toContain('owner.lock')
})
