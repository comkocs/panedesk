/** Metadata changes trigger content checks without independently revoking trust. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync, statSync, utimesSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { protectedInputCovered } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('@panedesk/dsh-sandbox-windows-acl', async importOriginal => ({
  ...await importOriginal<typeof import('@panedesk/dsh-sandbox-windows-acl')>(), assertWindowsStateTrusted: () => {},
}))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-metadata-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  const first = join(workspace, 'first.js')
  const last = join(workspace, 'last.js')
  writeFileSync(first, 'export const value = 1')
  writeFileSync(last, 'export const value = 2')
  const integrity = new ProtectedInputIntegrity(workspace, join(root, 'owner'))
  integrity.observe(workspace)
  const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  return { root, workspace, first, last, integrity, owner }
}

it.each(['capture', 'verify'] as const)('accepts another project adding a store hard link during %s', async (operation) => {
  const f = fixture()
  if (operation === 'verify') await f.integrity.grantWrite()
  const original = fs.openSync
  let linked = false
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.last && args[1] === 'r' && !linked) {
      linked = true
      linkSync(f.first, join(f.root, 'another-project-link'))
    }
    return original(...args)
  })
  if (operation === 'capture') await expect(f.integrity.grantWrite()).resolves.toBeUndefined()
  else await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(linked).toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it.each(['capture', 'verify'] as const)('rejects changed bytes with restored mtime during %s', async (operation) => {
  const f = fixture()
  if (operation === 'verify') await f.integrity.grantWrite()
  const original = fs.openSync
  let changed = false
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.last && args[1] === 'r' && !changed) {
      changed = true
      const before = statSync(f.first)
      writeFileSync(f.first, 'export const value = 9')
      utimesSync(f.first, before.atime, before.mtime)
    }
    return original(...args)
  })
  const result = operation === 'capture' ? f.integrity.grantWrite() : f.integrity.verify(f.owner)
  await expect(result).rejects.toThrow('changed while being read')
  expect(changed).toBe(true)
})

it('does not read content on unchanged mature metadata during agent verification', async () => {
  const f = fixture()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 10_000)
  await f.integrity.grantWrite()
  const read = vi.spyOn(fs, 'openSync')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(read.mock.calls.filter(([, flags]) => flags === 'r')).toHaveLength(0)
})

it('rereads a changed hard-link stamp without requiring owner confirmation', async () => {
  const f = fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  await f.integrity.grantWrite()
  linkSync(f.first, join(f.root, 'another-project-link'))
  const read = vi.spyOn(fs, 'openSync')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(read.mock.calls.filter(([path, flags]) => path === f.first && flags === 'r').length).toBeGreaterThan(0)
  expect(read.mock.calls.filter(([path, flags]) => path === f.last && flags === 'r')).toHaveLength(0)
  expect(f.owner.blocked).not.toHaveBeenCalled()
})

it('rejects changed content with restored mtime on the metadata verification path', async () => {
  const f = fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  await f.integrity.grantWrite()
  const before = statSync(f.first)
  writeFileSync(f.first, 'export const value = 9')
  utimesSync(f.first, before.atime, before.mtime)
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledTimes(1)
})

it('rereads recent stamps even when a same-granularity write preserves their values', async () => {
  const f = fixture()
  const lstat = fs.lstatSync
  const stat = fs.statSync
  const before = fs.statSync(f.first, { bigint: true })
  await f.integrity.grantWrite()
  writeFileSync(f.first, 'export const value = 9')
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => args[0] === f.first && args[1]?.bigint === true ? before : lstat(...args))
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => args[0] === f.first && args[1]?.bigint === true ? before : stat(...args))
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledTimes(1)
})

it('keeps early reads recent when verification crosses a timestamp-granularity window', async () => {
  const f = fixture()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const lstat = fs.lstatSync
  const stat = fs.statSync
  const before = fs.statSync(f.first, { bigint: true })
  await f.integrity.grantWrite()
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => args[0] === f.first && args[1]?.bigint === true ? before : lstat(...args))
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => args[0] === f.first && args[1]?.bigint === true ? before : stat(...args))
  const original = fs.openSync
  let changed = false
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.last && args[1] === 'r' && !changed) {
      changed = true
      writeFileSync(f.first, 'export const value = 9')
      clock.mockReturnValue(now + 10_000)
    }
    return original(...args)
  })
  await f.integrity.verify(f.owner)
  expect(changed).toBe(true)
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalled()
})

it('retains bilingual capture failure and recovery instructions for all waiting consumers', async () => {
  const f = fixture()
  const original = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.first && args[1] === 'r') throw new Error('capture interrupted')
    return original(...args)
  })
  const message = 'Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline. / 受保护宿主输入捕获失败。请重新显式授权该工作区写入一次，以重新捕获基线。 Error: capture interrupted'
  await expect(f.integrity.grantWrite()).rejects.toThrow(message)
  await expect(f.integrity.waitForCapture()).rejects.toThrow(message)
  await expect(f.integrity.verify(f.owner)).rejects.toThrow(message)
  expect(f.integrity.covers(f.first)).toBe(false)
})

it('matches full reads across seeded randomized content, metadata, type and link changes', async () => {
  let seed = 0x6d202611
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (let group = 0; group < 24; group++) {
    const f = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    await f.integrity.grantWrite()
    const full = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner'))
    switch (next() % 6) {
      case 0: linkSync(f.first, join(f.root, 'extra-link')); break
      case 1: {
        const before = statSync(f.first)
        writeFileSync(f.first, `export const value = ${next()}`)
        utimesSync(f.first, before.atime, before.mtime)
        break
      }
      case 2: chmodSync(f.first, 0o600); break
      case 3: unlinkSync(f.first); mkdirSync(f.first); break
      case 4: unlinkSync(f.first); symlinkSync(f.last, f.first); break
      case 5: utimesSync(f.first, new Date(0), new Date(0)); break
    }
    const fastBlocked = vi.fn()
    const fullBlocked = vi.fn()
    const fastResult = await f.integrity.verify({ blocked: fastBlocked, confirm: async () => false })
    const fullResult = await full.verify({ blocked: fullBlocked, confirm: async () => false })
    expect(fastResult).toBe(fullResult)
    expect(fastBlocked.mock.calls).toEqual(fullBlocked.mock.calls)
    vi.restoreAllMocks()
  }
})

it('queries additional workspace records without creating trust', async () => {
  const f = fixture()
  await f.integrity.grantWrite()
  const profile: ProfileContext = { name: 'test', dir: f.workspace, patchPath: f.first, installAnchor: f.workspace,
    cwd: f.workspace, home: f.root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    inputIntegrities: new Map([[f.workspace, f.integrity]]) }
  expect(protectedInputCovered(profile, f.first)).toBe(true)
  expect(protectedInputCovered(profile, join(f.root, 'outside'))).toBe(false)
})

it.each(['darwin', 'win32'] as const)('uses the platform verification policy for %s', async (platform) => {
  const f = fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  await f.integrity.grantWrite()
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const read = vi.spyOn(fs, 'openSync')
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(read.mock.calls.some(([path, flags]) => path === f.first && flags === 'r')).toBe(platform === 'darwin')
})

it.each(['link', 'content', 'mode'] as const)('rechecks a %s change within an open file read', async (change) => {
  const f = fixture()
  const original = fs.readSync
  let changed = false
  vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const result = original(...args)
    if (result > 0 && !changed) {
      changed = true
      if (change === 'link') linkSync(f.first, join(f.root, 'extra-link'))
      else if (change === 'mode') chmodSync(f.first, 0o600)
      else writeFileSync(f.first, 'export const value = 9')
    }
    return result
  })
  if (change === 'link') await expect(f.integrity.grantWrite()).resolves.toBeUndefined()
  else await expect(f.integrity.grantWrite()).rejects.toThrow('changed while being read')
})
