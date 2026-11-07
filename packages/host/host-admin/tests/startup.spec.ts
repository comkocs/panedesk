/** Administration startup waits for an active private-file provider and reports failures through Cordis. */
import { afterEach, expect, test } from 'vitest'
import { Context, FiberState } from '@panedesk/cordis'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import * as Admin from '../src/index.ts'
import { mountAdmin } from '../src/runtime.ts'
import type { PrivateFiles } from '../src/private-files.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const config: Admin.Config = { runtime: { directory: '/private', nodeId: 'node-a', principalId: 'operator-a',
  port: 0, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100 } }

function start(ctx: Context, options = config) {
  return ctx.plugin(Admin, options)
}
function context() {
  const ctx = new Context(), logs: string[] = []
  ctx.logger.exporter({ export(message) { logs.push(String(message.args[0])) } })
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, logs }
}

/** In-memory private files. Stores bytes the caller already holds; adds no access check. */
function memoryFiles(root: string): PrivateFiles & { readonly names: () => string[] } {
  const files = new Map<string, string>()
  let locked = false
  return {
    names: () => [...files.keys()],
    async prepare() {},
    async read(name, _maxBytes) { return files.get(`${root}/${name}`) ?? null },
    async write(name, content) { files.set(`${root}/${name}`, content) },
    async remove(name) { files.delete(`${root}/${name}`) },
    async lock() {
      if (locked) throw new Error('Private lock unavailable')
      locked = true
      files.set(`${root}/owner.lock`, 'held')
      return async () => { locked = false; files.delete(`${root}/owner.lock`) }
    },
  }
}

test('checks startup liveness without retaining effects or accepting an unloading fiber', async () => {
  const { ctx } = context()
  const fiber = await ctx.plugin(() => {})
  const effects = fiber.getEffects()
  expect(Admin.isPrivateFilesContextActive(fiber.ctx)).toBe(true)
  expect(fiber.getEffects()).toEqual(effects)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  fiber.effect(() => () => waiting)
  const restarting = fiber.restart()
  try {
    expect(fiber.uid).not.toBeNull()
    expect(fiber.state).toBe(FiberState.UNLOADING)
    expect(Admin.isPrivateFilesContextActive(fiber.ctx)).toBe(false)
  } finally { release(); await restarting }
  expect(Admin.isPrivateFilesContextActive(fiber.ctx)).toBe(true)
  await fiber.dispose()
  expect(Admin.isPrivateFilesContextActive(fiber.ctx)).toBe(false)
})

test('publishes the endpoint and credential through the supplied private files', async () => {
  const files = memoryFiles(config.runtime!.directory), { ctx, logs } = context()
  ctx.provide('hostAdminFiles', () => files)
  const dispose = await mountAdmin(ctx, config)
  cleanups.push(dispose)
  expect((await files.read('credential', 128))?.length).toBe(64)
  expect(JSON.parse((await files.read('endpoint.json', 4096)) ?? '')).toMatchObject({ nodeId: 'node-a' })
  expect(logs).toEqual([])
  await dispose()
  expect(files.names()).toEqual([])
})

test('fails visibly when private-file preparation rejects', async () => {
  const files = memoryFiles(config.runtime!.directory), { ctx } = context()
  files.prepare = async () => { throw new Error('Private directory unavailable') }
  ctx.provide('hostAdminFiles', () => files)
  await expect(mountAdmin(ctx, config)).rejects.toThrow('Private directory unavailable')
  expect(files.names()).toEqual([])
})

test('keeps empty administration inert', async () => {
  const { ctx, logs } = context(), fiber = start(ctx, {})
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('hostAdmin')).toBeUndefined()
  expect(logs).toEqual([])
})

test('keeps POSIX administration on the platform private-file policy', async () => {
  const root = await fs.mkdtemp(join(process.cwd(), '.admin-posix-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, logs } = context()
  const fiber = ctx.plugin(Admin, { runtime: { ...config.runtime!, directory: root } })
  await fiber
  await expect.poll(async () => (await fs.readdir(root)).includes('endpoint.json')).toBe(true)
  expect((await fs.stat(join(root, 'credential'))).mode & 0o777).toBe(0o600)
  expect(logs).toEqual([])
})
