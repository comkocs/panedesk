/** Windows startup waits for an active private-file provider and reports failures through Cordis. */
import { afterEach, expect, test, vi } from 'vitest'
import { Context, FiberState } from '@panedesk/cordis'
import * as fs from 'node:fs/promises'
import { join, win32 } from 'node:path'
import * as Admin from '../src/index.ts'
import { WindowsPrivateFiles } from '../src/windows-private-files.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const config: Admin.Config = { runtime: { directory: 'C:\\private', nodeId: 'node-a', principalId: 'operator-a',
  port: 0, maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100 } }

function start(ctx: Context, options = config) {
  return ctx.plugin({ name: Admin.name, apply(owner: Context) {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try { return Admin.apply(owner, options) }
    finally { Object.defineProperty(process, 'platform', platform) }
  } })
}
function context() {
  const ctx = new Context(), logs: string[] = []
  ctx.logger.exporter({ export(message) { logs.push(String(message.args[0])) } })
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, logs }
}
async function fixture() {
  const root = await fs.mkdtemp(join(process.cwd(), '.admin-startup-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const mapped = (path: string) => join(root, ...path.slice(3).split('\\').filter(Boolean))
  const secured = new Set<string>(), writes: string[] = []
  const sid = 'S-1-5-21-100-200-300-1001'
  const metadata = { reparse: false, parents: true, sid, owner: sid, protected: true,
    rules: [{ sid, inherited: false, allow: true, rights: 2032127, propagation: 0 }] }
  const files = new WindowsPrivateFiles(config.runtime!.directory, {
    execute: async (script) => {
      const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1]
      if (!encoded) throw new Error('Expected encoded path')
      const path = Buffer.from(encoded, 'base64').toString('utf8')
      if (script.includes('Set-Acl')) {
        const stat = await fs.stat(mapped(path))
        expect(stat.isDirectory() || stat.size === 0).toBe(true)
        secured.add(path)
        return ''
      }
      return JSON.stringify({ ...metadata, directory: metadata })
    },
    filesystem: {
      lstat: path => fs.lstat(mapped(path)), mkdir: path => fs.mkdir(mapped(path)),
      rmdir: path => fs.rmdir(mapped(path)), unlink: path => fs.unlink(mapped(path)),
      open: async (path, flags) => {
        const handle = await fs.open(mapped(path), flags)
        if (flags === 'wx') {
          const write = handle.writeFile.bind(handle)
          vi.spyOn(handle, 'writeFile').mockImplementation(async (...args) => {
            expect(secured.has(path)).toBe(true)
            writes.push(win32.basename(path))
            return write(...args)
          })
        }
        return handle
      },
    },
    replace: (source, target) => fs.rename(mapped(source), mapped(target)),
  })
  return { files, mapped, writes }
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

test('waits for a late active Windows factory before publishing ACL-protected endpoint and credential', async () => {
  const f = await fixture(), { ctx, logs } = context()
  const fiber = start(ctx)
  await vi.waitFor(() => { expect(fiber.state).toBe(FiberState.LOADING) })
  expect(ctx.get('hostAdmin')).toBeUndefined()
  let release!: () => void
  const loading = new Promise<void>((resolve) => { release = resolve })
  const factory = vi.fn(() => f.files)
  const provider = ctx.plugin(async (owner) => { owner.provide('hostAdminFiles', factory); await loading })
  await vi.waitFor(() => { expect(ctx.get('hostAdminFiles', false)).toBeDefined() })
  expect(ctx.get('hostAdminFiles')).toBeUndefined()
  expect(factory).not.toHaveBeenCalled()
  release(); await provider; await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect((await fs.stat(f.mapped('C:\\private\\credential'))).size).toBe(64)
  expect(JSON.parse(await fs.readFile(f.mapped('C:\\private\\endpoint.json'), 'utf8'))).toMatchObject({ nodeId: 'node-a' })
  expect(f.writes).toHaveLength(3)
  expect(logs).toEqual([])
  await fiber.dispose()
  expect(ctx.get('hostAdmin')).toBeUndefined()
  expect(await fs.readdir(f.mapped('C:\\private'))).toEqual([])
})

test.each(['SIGINT', 'SIGTERM'] as const)('removes the administration lock after %s termination', async (signal) => {
  const f = await fixture(), { ctx } = context()
  ctx.provide('hostAdminFiles', () => f.files)
  const fiber = start(ctx)
  await fiber
  expect(await fs.readdir(f.mapped('C:\\private'))).toContain('owner.lock')
  const handler = process.listeners(signal).at(-1)!
  handler(signal)
  await expect.poll(() => fs.readdir(f.mapped('C:\\private'))).toEqual([])
  await fiber.dispose()
})

test.each(['missing', 'factory', 'preparation'])('abandons disposed Windows administration during %s startup', async (stage) => {
  const f = await fixture(), { ctx, logs } = context()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const prepare = f.files.prepare.bind(f.files)
  const preparing = vi.spyOn(f.files, 'prepare').mockImplementation(async () => { await waiting; await prepare() })
  const fiber = start(ctx)
  await vi.waitFor(() => { expect(fiber.state).toBe(FiberState.LOADING) })
  if (stage !== 'missing') ctx.provide('hostAdminFiles', () => f.files)
  if (stage === 'preparation') await vi.waitFor(() => { expect(preparing).toHaveBeenCalled() })
  const closing = fiber.dispose()
  release()
  await closing
  expect(ctx.get('hostAdmin')).toBeUndefined()
  expect(ctx.get('hostSessionCredentials')).toBeUndefined()
  expect(logs).toEqual([])
  if (stage === 'preparation') expect(await fs.readdir(f.mapped('C:\\private'))).toEqual([])
})

test('fails visibly when the Windows private-file factory is missing', async () => {
  const { ctx, logs } = context(), fiber = start(ctx)
  await expect(fiber.await()).rejects.toThrow('hostAdminFiles unavailable')
  expect(fiber.state).toBe(FiberState.FAILED)
  expect(logs.some(line => line.includes('hostAdminFiles unavailable'))).toBe(true)
  expect(ctx.get('hostAdmin')).toBeUndefined()
})

test('reports Windows file preparation failure instead of leaving administration active', async () => {
  const f = await fixture(), { ctx, logs } = context()
  vi.spyOn(f.files, 'prepare').mockRejectedValue(new Error('Private ACL rights rejected'))
  ctx.provide('hostAdminFiles', () => f.files)
  const fiber = start(ctx)
  await expect(fiber.await()).rejects.toThrow('Private ACL rights rejected')
  expect(fiber.state).toBe(FiberState.FAILED)
  expect(logs.some(line => line.includes('Private ACL rights rejected'))).toBe(true)
  expect(ctx.get('hostAdmin')).toBeUndefined()
})

test('keeps empty Windows administration inert without waiting for a factory', async () => {
  const { ctx, logs } = context(), fiber = start(ctx, {})
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('hostAdmin')).toBeUndefined()
  expect(logs).toEqual([])
})

test('keeps POSIX administration independent of a Windows factory', async () => {
  const root = await fs.mkdtemp(join(process.cwd(), '.admin-posix-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, logs } = context()
  const fiber = ctx.plugin(Admin, { runtime: { ...config.runtime!, directory: root } })
  await fiber
  await expect.poll(async () => (await fs.readdir(root)).includes('endpoint.json')).toBe(true)
  expect((await fs.stat(join(root, 'credential'))).mode & 0o777).toBe(0o600)
  expect(logs).toEqual([])
})
