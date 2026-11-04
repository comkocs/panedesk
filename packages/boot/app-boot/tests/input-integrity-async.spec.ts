/** Capture completion is the publication point for workspace trust. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { ProtectedInputIntegrity as ReferenceIntegrity } from './protected-input-reference.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-capture-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  const directory = join(workspace, 'plugins')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'entry.js')
  writeFileSync(path, 'export const value = 1')
  const home = join(root, 'owner')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(directory)
  integrity.observe(path)
  integrity.observe(workspace)
  return { root, workspace, directory, path, home, integrity }
}

it('does not publish workspace trust until asynchronous capture completes', async () => {
  const f = fixture()
  const pending = f.integrity.grantWrite()
  expect(f.integrity.covers(f.path)).toBe(false)
  await pending
  expect(f.integrity.covers(f.path)).toBe(true)
})

it('shares one capture between simultaneous workspace grants', async () => {
  const f = fixture()
  const read = vi.spyOn(fs, 'openSync')
  const enumerate = vi.spyOn(fs, 'readdirSync')
  const first = f.integrity.grantWrite()
  const second = f.integrity.grantWrite()
  expect(f.integrity.covers(f.path)).toBe(false)
  await Promise.all([first, second])
  expect(read.mock.calls.filter(([path, flags]) => path === f.path && flags === 'r')).toHaveLength(1)
  expect(enumerate.mock.calls.filter(([path]) => path === f.directory)).toHaveLength(1)
  expect(f.integrity.readTrusted(f.path)?.toString()).toBe('export const value = 1')
})

it('rejects a failed grant without publishing trusted inputs', async () => {
  const f = fixture()
  const original = fs.openSync
  const read = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.path && args[1] === 'r') throw new Error('capture interrupted')
    return original(...args)
  })
  try {
    await expect(Promise.resolve().then(() => f.integrity.grantWrite())).rejects.toThrow('capture interrupted')
    expect(f.integrity.covers(f.path)).toBe(false)
  } finally { read.mockRestore() }
})

it('rejects failed captures and captures again on the next grant', async () => {
  const f = fixture()
  const original = fs.openSync
  const read = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.path && args[1] === 'r') throw new Error('capture interrupted')
    return original(...args)
  })
  await expect(Promise.resolve().then(() => f.integrity.grantWrite())).rejects.toThrow('capture interrupted')
  expect(f.integrity.covers(f.path)).toBe(false)
  await expect(f.integrity.waitForCapture()).rejects.toThrow('capture interrupted')
  read.mockRestore()
  await f.integrity.grantWrite()
  await expect(f.integrity.waitForCapture()).resolves.toBeUndefined()
  expect(f.integrity.covers(f.path)).toBe(true)
})

it.each(['grant', 'verify'] as const)('refuses %s publication when a root is registered during final checks', async (operation) => {
  const f = fixture()
  let integrity = new ProtectedInputIntegrity(f.workspace, f.home)
  integrity.observe(f.path)
  const late = join(f.workspace, 'late.yml')
  writeFileSync(late, 'late protected input')
  if (operation === 'verify') {
    await integrity.grantWrite()
    integrity = new ProtectedInputIntegrity(f.workspace, f.home)
  }
  const original = fs.statSync
  let reads = 0
  const stat = vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    if (args[0] === f.path && ++reads === (operation === 'grant' ? 3 : 6)) integrity.observe(late)
    return original(...args)
  })
  try {
    const result = Promise.resolve().then(async () => {
      if (operation === 'grant') await integrity.grantWrite()
      else await integrity.verify({ blocked() {}, confirm: async () => true })
    })
    await expect(result).rejects.toThrow('Protected host input registered during capture')
    expect(integrity.covers(late)).toBe(false)
  } finally { stat.mockRestore() }
})

it('lets event-loop work run before capture publishes its baseline', async () => {
  const f = fixture()
  const pending = f.integrity.grantWrite()
  await setImmediate()
  expect(f.integrity.covers(f.path)).toBe(false)
  await pending
  expect(f.integrity.covers(f.path)).toBe(true)
})

it.each(['overlap', 'external-link', 'directory-cycle'] as const)(
  'rejects cross-root edits during shared capture like the reference for %s', async (layout) => {
    const f = fixture()
    const target = layout === 'external-link' ? join(f.root, 'external') : join(f.workspace, 'later')
    mkdirSync(target)
    const later = join(target, 'last.js')
    writeFileSync(later, 'later input')
    const logical = join(f.workspace, 'last-root')
    symlinkSync(target, logical, process.platform === 'win32' ? 'junction' : 'dir')
    if (layout === 'directory-cycle') symlinkSync(f.directory, join(target, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
    const reference = new ReferenceIntegrity(f.workspace, join(f.root, 'reference-owner'))
    for (const integrity of [reference, f.integrity]) {
      integrity.observe(f.directory)
      integrity.observe(f.path)
      integrity.observe(logical)
      writeFileSync(f.path, 'export const value = 1')
      const original = fs.openSync
      const opened = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        if (args[0] === later && args[1] === 'r') writeFileSync(f.path, 'changed while reading another root')
        return original(...args)
      })
      try {
        await expect(Promise.resolve().then(() => integrity.grantWrite())).rejects.toThrow('changed while being read')
        expect(integrity.covers(f.path)).toBe(false)
      } finally { opened.mockRestore() }
    }
  },
)

it('rechecks strict legacy records without ancestors using the reference digest', async () => {
  const f = fixture()
  const referenceHome = join(f.root, 'legacy-reference')
  const recordName = createHash('sha256').update(fs.realpathSync(f.workspace)).digest('hex') + '.json'
  for (const home of [f.home, referenceHome]) {
    const directory = join(home, 'windows-workspace-write', 'protected-inputs')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, recordName), JSON.stringify({ version: 1, workspace: fs.realpathSync(f.workspace),
      inputs: [f.directory, f.path, f.workspace].map(path => ({ path, snapshot: {
        digest: '0'.repeat(64), kind: path === f.path ? 'file' : 'directory', target: path, content: null,
      } })),
    }))
  }
  const reference = new ReferenceIntegrity(f.workspace, referenceHome)
  expect(await reference.verify({ blocked() {}, confirm: async () => true })).toBe(true)
  const name = (home: string) => join(home, 'windows-workspace-write', 'protected-inputs', recordName)
  fs.copyFileSync(name(referenceHome), name(f.home))
  fs.cpSync(join(referenceHome, 'windows-workspace-write', 'protected-inputs', 'blobs'),
    join(f.home, 'windows-workspace-write', 'protected-inputs', 'blobs'), { recursive: true })
  const current = new ProtectedInputIntegrity(f.workspace, f.home)
  const rejected = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  expect(await current.verify(rejected)).toBe(true)
  expect(rejected.confirm).not.toHaveBeenCalled()
  expect(current.readTrusted(f.path)).toEqual(reference.readTrusted(f.path))
  writeFileSync(f.path, 'export const legacy = 2')
  const oldChanges = vi.fn()
  const newChanges = vi.fn()
  expect(await reference.verify({ blocked: oldChanges, confirm: async () => false })).toBe(false)
  expect(await current.verify({ blocked: newChanges, confirm: async () => false })).toBe(false)
  expect(newChanges.mock.calls).toEqual(oldChanges.mock.calls)
})

it.each(['overlap', 'external-link', 'directory-cycle'] as const)(
  'preserves snapshots, trusted copies, cross-root checks and historical records for %s', async (layout) => {
    const f = fixture()
    if (layout !== 'overlap') {
      const target = layout === 'directory-cycle' ? f.workspace : join(f.root, 'external')
      if (layout === 'external-link') {
        mkdirSync(target)
        writeFileSync(join(target, 'external.js'), 'export const external = true')
      }
      symlinkSync(target, join(f.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const referenceHome = join(f.root, 'reference-owner')
    const reference = new ReferenceIntegrity(f.workspace, referenceHome)
    reference.observe(f.directory)
    reference.observe(f.path)
    reference.observe(f.workspace)
    reference.grantWrite()
    await f.integrity.grantWrite()
    const record = (home: string): unknown => {
      const directory = join(home, 'windows-workspace-write', 'protected-inputs')
      const name = fs.readdirSync(directory).find(name => name.endsWith('.json'))
      if (name === undefined) throw new Error('Missing capture record')
      return JSON.parse(readFileSync(join(directory, name), 'utf8'))
    }
    expect(record(f.home)).toEqual(record(referenceHome))
    expect(f.integrity.readTrusted(f.path)).toEqual(reference.readTrusted(f.path))
    const historical = new ProtectedInputIntegrity(f.workspace, referenceHome)
    expect(await historical.verify({ blocked: vi.fn(), confirm: async () => false })).toBe(true)
    writeFileSync(f.path, 'export const value = 2')
    const currentBlocked = vi.fn()
    const referenceBlocked = vi.fn()
    expect(await f.integrity.verify({ blocked: currentBlocked, confirm: async () => false })).toBe(false)
    expect(await reference.verify({ blocked: referenceBlocked, confirm: async () => false })).toBe(false)
    expect(currentBlocked.mock.calls).toEqual(referenceBlocked.mock.calls)
    expect(f.integrity.readTrusted(f.path)).toEqual(reference.readTrusted(f.path))
  },
)
