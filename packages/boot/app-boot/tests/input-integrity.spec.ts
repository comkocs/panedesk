/** Exact owner consent cannot authorize a replacement made while a prompt is open. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-integrity-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  const path = join(workspace, 'patch.yml')
  writeFileSync(path, 'initial')
  const integrity = new ProtectedInputIntegrity(workspace)
  integrity.observe(path)
  return { root, workspace, path, integrity }
}

it('keeps rejecting a changed input after owner refusal and accepts the exact allowed version', async () => {
  const f = fixture()
  writeFileSync(f.path, 'owner edit')
  const blocked = vi.fn()
  const reject = vi.fn(async () => false)
  expect(await f.integrity.verify({ blocked, confirm: reject })).toBe(false)
  expect(await f.integrity.verify({ blocked, confirm: reject })).toBe(false)
  expect(blocked).toHaveBeenCalledTimes(2)
  const allow = vi.fn(async () => true)
  expect(await f.integrity.verify({ blocked, confirm: allow })).toBe(true)
  expect(readFileSync(f.path, 'utf8')).toBe('owner edit')
  expect(await f.integrity.verify({ blocked, confirm: reject })).toBe(true)
  expect(reject).toHaveBeenCalledTimes(2)
})

it('does not accept different bytes substituted while the owner is answering', async () => {
  const f = fixture()
  writeFileSync(f.path, 'first candidate')
  const blocked = vi.fn()
  expect(await f.integrity.verify({ blocked, confirm: async () => {
    writeFileSync(f.path, 'second candidate')
    return true
  } })).toBe(false)
  expect(blocked).toHaveBeenCalledTimes(2)
  expect(await f.integrity.verify({ blocked, confirm: async () => false })).toBe(false)
})

it('rejects a second protected file changed while another input is being approved', async () => {
  const f = fixture()
  const other = join(f.workspace, 'other.yml')
  writeFileSync(other, 'initial')
  f.integrity.observe(other)
  writeFileSync(f.path, 'candidate')
  const blocked = vi.fn()
  expect(await f.integrity.verify({ blocked, confirm: async () => {
    writeFileSync(other, 'unapproved')
    return true
  } })).toBe(false)
  expect(blocked).toHaveBeenCalledTimes(2)
})

it('asks the owner before accepting a directory replaced by a symbolic link', async () => {
  const f = fixture()
  const directory = join(f.workspace, 'plugins')
  const target = join(f.workspace, 'replacement')
  mkdirSync(directory)
  mkdirSync(target)
  f.integrity.observe(directory)
  rmSync(directory, { recursive: true })
  symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir')
  const blocked = vi.fn()
  const confirm = vi.fn(async () => false)
  expect(await f.integrity.verify({ blocked, confirm })).toBe(false)
  expect(blocked).toHaveBeenCalledOnce()
  expect(confirm).toHaveBeenCalledOnce()
})

it('retains the trusted copy across restart after an offline edit', async () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const first = new ProtectedInputIntegrity(f.workspace, home)
  first.observe(f.path)
  first.grantWrite()
  writeFileSync(f.path, 'offline edit')
  const restarted = new ProtectedInputIntegrity(f.workspace, home)
  restarted.observe(f.path)
  expect(await restarted.verify({ blocked: vi.fn(), confirm: async () => false })).toBe(false)
  expect(restarted.readTrusted(f.path)?.toString()).toBe('initial')
})

it('reports coverage only after a durable write grant and rejects state inside the workspace', () => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(f.path)
  expect(integrity.covers(f.path)).toBe(false)
  integrity.grantWrite()
  expect(integrity.covers(f.path)).toBe(true)
  expect(integrity.covers(join(f.workspace, 'unrelated'))).toBe(false)
  const unsafe = new ProtectedInputIntegrity(f.workspace, join(f.workspace, 'owner-state'))
  unsafe.observe(f.path)
  expect(() => { unsafe.grantWrite() }).toThrow('outside the writable workspace')
})

it('reads an ungranted workspace with nested home without permitting a durable grant', async () => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.workspace, 'owner-state'))
  integrity.observe(f.path)
  expect(integrity.covers(f.path)).toBe(false)
  expect(integrity.readTrusted(f.path)?.toString()).toBe('initial')
  expect(integrity.readExecutable(f.path)).toBeUndefined()
  const confirm = vi.fn(async () => false)
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  expect(() => { integrity.grantWrite() }).toThrow('outside the writable workspace')
})

it('rejects an owner-state directory linked into the writable workspace', () => {
  const f = fixture()
  const linkedHome = join(f.root, 'linked-home')
  symlinkSync(f.workspace, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
  const integrity = new ProtectedInputIntegrity(f.workspace, linkedHome)
  integrity.observe(f.path)
  expect(() => { integrity.grantWrite() }).toThrow('outside the writable workspace')
})

it('reuses durable trust through a workspace directory alias', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const first = new ProtectedInputIntegrity(f.workspace, home)
  first.observe(f.path)
  first.grantWrite()
  const alias = join(f.root, 'workspace-alias')
  symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(f.path, 'offline edit')
  const restarted = new ProtectedInputIntegrity(alias, home)
  expect(restarted.readTrusted(join(alias, 'patch.yml'))?.toString()).toBe('initial')
})

it('rejects overlapping verification without replacing the pending owner candidate', async () => {
  const f = fixture()
  writeFileSync(f.path, 'candidate')
  const result = f.integrity.verify({ blocked: vi.fn(), confirm: async () => {
    await expect(f.integrity.verify({ blocked: vi.fn(), confirm: async () => true }))
      .rejects.toThrow('verification is already pending')
    return false
  } })
  expect(await result).toBe(false)
  expect(f.integrity.readTrusted(f.path)?.toString()).toBe('initial')
})

it('does not establish trust or prompt before workspace write access is granted', async () => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(f.path)
  writeFileSync(f.path, 'owner edit before grant')
  const confirm = vi.fn(async () => false)
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(integrity.readTrusted(f.path)?.toString()).toBe('owner edit before grant')
  expect(confirm).not.toHaveBeenCalled()
  integrity.grantWrite()
  writeFileSync(f.path, 'model edit in the same session')
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(false)
  expect(integrity.readTrusted(f.path)?.toString()).toBe('owner edit before grant')
})

it.each(['edit-module', 'add-module', 'retarget', 'directory', 'file', 'recreate'] as const)(
  'rejects an unconfirmed linked plugin change: %s', async (method) => {
    const f = fixture()
    const target = join(f.root, 'plugin-source')
    const replacement = join(f.root, 'replacement-source')
    mkdirSync(target)
    mkdirSync(replacement)
    writeFileSync(join(target, 'index.js'), 'export const value = 1')
    writeFileSync(join(replacement, 'index.js'), 'export const value = 2')
    const link = join(f.workspace, 'node_modules')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    f.integrity.observe(link)
    if (method === 'edit-module') writeFileSync(join(target, 'index.js'), 'export const value = 2')
    else if (method === 'add-module') writeFileSync(join(target, 'dynamic.js'), 'export const value = 2')
    else {
      unlinkSync(link)
      if (method === 'directory') mkdirSync(link)
      else if (method === 'file') writeFileSync(link, 'replacement')
      else symlinkSync(method === 'retarget' ? replacement : target, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const blocked = vi.fn()
    const confirm = vi.fn(async () => false)
    expect(await f.integrity.verify({ blocked, confirm })).toBe(false)
    expect(blocked).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledOnce()
    expect(await f.integrity.verify({ blocked, confirm: async () => true })).toBe(true)
  },
)

it('returns verified module bytes and rejects newly added modules until exact owner approval', async () => {
  const f = fixture()
  const directory = join(f.workspace, 'plugin')
  mkdirSync(directory)
  const entry = join(directory, 'index.js')
  writeFileSync(entry, 'export const value = 1')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(directory)
  integrity.grantWrite()
  expect(integrity.readExecutable(entry)?.toString()).toBe('export const value = 1')
  const dynamic = join(directory, 'dynamic.js')
  writeFileSync(dynamic, 'export const value = 2')
  expect(() => integrity.readExecutable(dynamic)).toThrow('requires owner confirmation')
  expect(await integrity.verify({ blocked: vi.fn(), confirm: async () => true })).toBe(true)
  const approved = integrity.readExecutable(dynamic)
  writeFileSync(dynamic, 'export const value = 3')
  expect(approved?.toString()).toBe('export const value = 2')
  expect(() => integrity.readExecutable(dynamic)).toThrow('requires owner confirmation')
})

it('validates canonical linked module bytes against the recorded link tree', () => {
  const f = fixture()
  const target = join(f.root, 'plugin-target')
  mkdirSync(target)
  const entry = join(target, 'index.js')
  writeFileSync(entry, 'initial')
  const link = join(f.workspace, 'plugin')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(link)
  integrity.grantWrite()
  expect(integrity.readExecutable(entry)?.toString()).toBe('initial')
  writeFileSync(entry, 'changed')
  expect(() => integrity.readExecutable(entry)).toThrow('requires owner confirmation')
})

it('rejects a newly resolved outside target after a protected link is redirected', () => {
  const f = fixture()
  const original = join(f.root, 'original-plugin')
  const replacement = join(f.root, 'replacement-plugin')
  mkdirSync(original)
  mkdirSync(replacement)
  writeFileSync(join(original, 'index.js'), 'original')
  const entry = join(replacement, 'index.js')
  writeFileSync(entry, 'replacement')
  const link = join(f.workspace, 'plugin')
  symlinkSync(original, link, process.platform === 'win32' ? 'junction' : 'dir')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(link)
  integrity.grantWrite()
  unlinkSync(link)
  symlinkSync(replacement, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => integrity.readExecutable(entry)).toThrow('requires owner confirmation')
})

it('loads trusted inputs from other granted workspaces before parsing a new launch', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const first = new ProtectedInputIntegrity(f.workspace, home)
  first.observe(f.path)
  first.grantWrite()
  writeFileSync(f.path, 'unapproved offline edit')
  const launch = join(f.root, 'another-project')
  mkdirSync(launch)
  const restarted = ProtectedInputIntegrity.openOwnerRecords(launch, home)
  expect(restarted.covers(f.path)).toBe(true)
  expect(restarted.readTrusted(f.path)?.toString()).toBe('initial')
})

it('refuses conflicting trusted copies from overlapping granted workspaces', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const nested = join(f.workspace, 'nested')
  mkdirSync(nested)
  const path = join(nested, 'config.yml')
  writeFileSync(path, 'first owner version')
  const first = new ProtectedInputIntegrity(f.workspace, home)
  first.observe(path)
  first.grantWrite()
  writeFileSync(path, 'second owner version')
  const second = new ProtectedInputIntegrity(nested, home)
  second.observe(path)
  second.grantWrite()
  expect(() => ProtectedInputIntegrity.openOwnerRecords(join(f.root, 'launch'), home))
    .toThrow('Conflicting protected host input records')
})

it('retains descendant configuration copies when only their directory was registered', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const directory = join(f.workspace, 'profile')
  mkdirSync(directory)
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, '{"name":"trusted"}')
  const first = new ProtectedInputIntegrity(f.workspace, home)
  first.observe(directory)
  first.grantWrite()
  writeFileSync(manifest, '{"name":"unapproved"}')
  const restarted = new ProtectedInputIntegrity(f.workspace, home)
  expect(restarted.covers(manifest)).toBe(true)
  expect(restarted.readTrusted(manifest)?.toString()).toBe('{"name":"trusted"}')
})

it('rejects a directory snapshot when an earlier descendant changes during traversal', () => {
  const f = fixture()
  const directory = join(f.workspace, 'tree')
  mkdirSync(directory)
  const first = join(directory, 'a.yml')
  const second = join(directory, 'b.yml')
  writeFileSync(first, 'first')
  writeFileSync(second, 'second')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(directory)
  const open = fs.openSync
  let reads = 0
  const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const bytes = open(...args)
    if (args[1] === 'r' && ++reads === 2) writeFileSync(first, 'changed during traversal')
    return bytes
  })
  try {
    expect(() => { integrity.grantWrite() }).toThrow('changed while being read')
  } finally {
    spy.mockRestore()
  }
  expect(integrity.covers(first)).toBe(false)
})

it('rejects an earlier linked root changed while a later root is captured', () => {
  const f = fixture()
  const firstTarget = join(f.root, 'first-target')
  const secondTarget = join(f.root, 'second-target')
  mkdirSync(firstTarget)
  mkdirSync(secondTarget)
  const first = join(firstTarget, 'index.js')
  writeFileSync(first, 'first')
  writeFileSync(join(secondTarget, 'index.js'), 'second')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  for (const [name, target] of [['first', firstTarget], ['second', secondTarget]] as const) {
    const link = join(f.workspace, name)
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    integrity.observe(link)
  }
  const open = fs.openSync
  let reads = 0
  const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const bytes = open(...args)
    if (args[1] === 'r' && ++reads === 2) writeFileSync(first, 'changed while reading another root')
    return bytes
  })
  try {
    expect(() => { integrity.grantWrite() }).toThrow('changed while being read')
  } finally {
    spy.mockRestore()
  }
  expect(integrity.covers(join(f.workspace, 'first', 'index.js'))).toBe(false)
  expect(new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state')).covers(first)).toBe(false)
})

it('refreshes an existing reader after another host commits an owner-approved revision', async () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const writer = new ProtectedInputIntegrity(f.workspace, home)
  writer.observe(f.path)
  writer.grantWrite()
  const reader = new ProtectedInputIntegrity(f.workspace, home)
  writeFileSync(f.path, 'approved by another host')
  expect(await writer.verify({ blocked: vi.fn(), confirm: async () => true })).toBe(true)
  expect(reader.readTrusted(f.path)?.toString()).toBe('approved by another host')
  expect(reader.readExecutable(f.path)?.toString()).toBe('approved by another host')
  const confirm = vi.fn(async () => false)
  expect(await reader.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})

it('refreshes trusted bytes after a separate owner process approves the replacement', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const reader = new ProtectedInputIntegrity(f.workspace, home)
  reader.observe(f.path)
  reader.grantWrite()
  writeFileSync(f.path, 'approved in another process')
  // This filesystem fixture imports no Cordis or profile composition.
  const entry = new URL('../src/input-integrity.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { ProtectedInputIntegrity } from ${JSON.stringify(entry)}
    const integrity = new ProtectedInputIntegrity(process.argv[1], process.argv[2])
    const accepted = await integrity.verify({ blocked() {}, confirm: async () => true })
    if (!accepted) throw new Error('Owner approval did not commit')
  `, f.workspace, home], { encoding: 'utf8', timeout: 10_000 })
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  expect(reader.readTrusted(f.path)?.toString()).toBe('approved in another process')
  expect(reader.readExecutable(f.path)?.toString()).toBe('approved in another process')
})

it('refuses deletion of an already granted durable record instead of trusting current files', () => {
  const f = fixture()
  const home = join(f.root, 'owner-state')
  const integrity = new ProtectedInputIntegrity(f.workspace, home)
  integrity.observe(f.path)
  integrity.grantWrite()
  rmSync(join(home, 'windows-workspace-write', 'protected-inputs'), { recursive: true })
  writeFileSync(f.path, 'untrusted after record loss')
  expect(() => integrity.readTrusted(f.path)).toThrow('Protected workspace record disappeared')
  expect(() => integrity.readExecutable(f.path)).toThrow('Protected workspace record disappeared')
})

it('captures deep linked dependency trees without exceeding the filesystem symlink limit', async () => {
  const f = fixture()
  const packages = join(f.root, 'packages')
  mkdirSync(packages)
  const directories = Array.from({ length: 48 }, (_, index) => join(packages, `package-${index}`))
  for (const directory of directories) mkdirSync(directory)
  for (const [index, directory] of directories.entries()) {
    const next = directories[index + 1]
    if (next !== undefined) symlinkSync(next, join(directory, 'dependency'), 'dir')
  }
  const entry = join(directories[directories.length - 1]!, 'index.js')
  writeFileSync(entry, 'trusted module')
  const link = join(f.workspace, 'plugin')
  symlinkSync(directories[0]!, link, 'dir')
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(link)
  integrity.grantWrite()
  const confirm = vi.fn(async () => false)
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  writeFileSync(entry, 'unconfirmed module')
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
})

it('accepts only ancestor permission tightening and still rejects owner changes', async () => {
  const f = fixture()
  let ancestorMode = 0o777n
  const originalStat = fs.lstatSync
  const platformStat = process.platform === 'win32' ? vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = originalStat(...args)
    // Windows chmod does not expose POSIX group/other bits; exercise the recorded mode comparison.
    if (args[0] === f.workspace && stat !== undefined && typeof stat.mode === 'bigint') {
      stat.mode = (stat.mode & ~0o777n) | ancestorMode
    }
    return stat
  }) : undefined
  onTestFinished(() => { platformStat?.mockRestore() })
  fs.chmodSync(f.workspace, 0o777)
  const integrity = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  integrity.observe(f.path)
  integrity.grantWrite()
  ancestorMode = 0o700n
  fs.chmodSync(f.workspace, 0o700)
  const confirm = vi.fn(async () => false)
  expect(await integrity.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  expect(integrity.readExecutable(f.path)?.toString()).toBe('initial')
  const restarted = new ProtectedInputIntegrity(f.workspace, join(f.root, 'owner-state'))
  ancestorMode = 0o777n
  fs.chmodSync(f.workspace, 0o777)
  expect(await restarted.verify({ blocked: vi.fn(), confirm })).toBe(false)
  ancestorMode = 0o700n
  fs.chmodSync(f.workspace, 0o700)
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = originalStat(...args)
    if (args[0] === f.workspace && stat !== undefined && typeof stat.uid === 'bigint') {
      if (process.platform === 'win32' && typeof stat.mode === 'bigint') stat.mode = (stat.mode & ~0o777n) | ancestorMode
      stat.uid += 1n
    }
    return stat
  })
  try {
    expect(await restarted.verify({ blocked: vi.fn(), confirm })).toBe(false)
  } finally { spy.mockRestore() }
})

it('leaves inputs outside the writable workspace unchanged', async () => {
  const f = fixture()
  const outside = join(f.root, 'outside.yml')
  writeFileSync(outside, 'initial')
  f.integrity.observe(outside)
  writeFileSync(outside, 'edited')
  const confirm = vi.fn(async () => false)
  expect(await f.integrity.verify({ blocked: vi.fn(), confirm })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})
