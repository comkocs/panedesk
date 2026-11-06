/** Protected module loads retain identity checks without repeated tree traversal. */
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { PluginPackages } from '../src/profile-resolution/service.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'protected-load-')))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  fs.mkdirSync(workspace)
  const entries = Array.from({ length: 8 }, (_, index) => join(workspace, `module-${index}.cjs`))
  for (const entry of entries) fs.writeFileSync(entry, 'module.exports = "approved"')
  const original = new ProtectedInputIntegrity(workspace, home)
  original.observe(workspace)
  await original.grantWrite()
  const reader = new ProtectedInputIntegrity(workspace, home)
  const ctx = new Context()
  ctx.provide('profileContext', {
    name: 'test', dir: workspace, patchPath: entries[0]!, installAnchor: entries[0]!, cwd: workspace,
    home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined, inputIntegrity: reader,
  })
  await ctx.plugin(PluginPackages)
  const require = createRequire(join(root, 'caller.cjs'))
  const load = (entry = entries[0]!): unknown => {
    Reflect.deleteProperty(require.cache, entry)
    return require(entry)
  }
  cleanup.push(async () => {
    await ctx.fiber.dispose()
    for (const entry of entries) Reflect.deleteProperty(require.cache, entry)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, home, entries, reader, load }
}

it('loads restarted modules with at most one root traversal per baseline', async () => {
  const f = await fixture()
  const readdir = vi.spyOn(fs, 'readdirSync')
  const lstat = vi.spyOn(fs, 'lstatSync')
  syncBuiltinESMExports()
  const counts: { traversals: number; siblingMetadata: number }[] = []
  for (const entry of f.entries) {
    readdir.mockClear()
    lstat.mockClear()
    expect(f.load(entry)).toBe('approved')
    counts.push({
      traversals: readdir.mock.calls.filter(([path]) => path === f.workspace).length,
      siblingMetadata: lstat.mock.calls.filter(([path]) => path === f.entries.at(-1)).length,
    })
  }
  console.log(JSON.stringify({ moduleLoadCounts: counts }))
  // Legacy records contain only a tree identity digest: one cold bootstrap is necessary,
  // but the other seven loads must not enumerate the root or inspect unrelated siblings.
  expect(counts.slice(1).map(count => count.traversals)).toEqual(Array(7).fill(0))
  expect(counts.slice(1, -1).map(count => count.siblingMetadata)).toEqual(Array(6).fill(0))
})

it('rejects changed bytes between repeated loads of the same URL', async () => {
  const f = await fixture()
  expect(f.load()).toBe('approved')
  fs.writeFileSync(f.entries[0]!, 'module.exports = "modified"')
  expect(() => f.load()).toThrow('requires owner confirmation')
})

it('rereads changed bytes despite restored mtime and a changed hard-link count', async () => {
  const f = await fixture()
  expect(f.load()).toBe('approved')
  const entry = f.entries[0]!
  const before = fs.statSync(entry)
  fs.linkSync(entry, join(f.root, 'alias.cjs'))
  fs.writeFileSync(entry, 'module.exports = "modified"')
  fs.utimesSync(entry, before.atime, before.mtime)
  expect(() => f.load()).toThrow('requires owner confirmation')
})

it('rejects a requested file replaced with a same-byte symlink', async () => {
  const f = await fixture()
  expect(f.load()).toBe('approved')
  const entry = f.entries[0]!
  const target = join(f.root, 'target.cjs')
  fs.copyFileSync(entry, target)
  fs.unlinkSync(entry)
  fs.symlinkSync(target, entry)
  expect(() => f.reader.readExecutable(entry)).toThrow('requires owner confirmation')
})

it('rejects an ancestor replaced with a symlink', async () => {
  const f = await fixture()
  expect(f.load()).toBe('approved')
  const moved = join(f.root, 'moved')
  fs.renameSync(f.workspace, moved)
  fs.symlinkSync(moved, f.workspace)
  expect(() => f.load()).toThrow('requires owner confirmation')
})

it('leaves outside-workspace modules to the native loader', async () => {
  const f = await fixture()
  const outside = join(f.root, 'outside.cjs')
  fs.writeFileSync(outside, 'module.exports = "outside"')
  expect(f.load(outside)).toBe('outside')
})

it('rechecks after owner reauthorization, revocation and root registration', async () => {
  const f = await fixture()
  expect(f.load()).toBe('approved')
  fs.writeFileSync(f.entries[0]!, 'module.exports = "modified"')
  await f.reader.grantWrite()
  expect(f.load()).toBe('modified')
  f.reader.invalidateWorkspace(f.workspace)
  f.reader.observe(f.entries[1]!)
  expect(f.load()).toBe('modified')
  fs.writeFileSync(f.entries[0]!, 'module.exports = "unapproved"')
  expect(() => f.load()).toThrow('requires owner confirmation')
})
