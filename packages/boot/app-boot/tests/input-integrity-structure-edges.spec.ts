import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { checkAuthoritativeTree } from '../src/input-integrity-structure.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const home = fs.mkdtempSync(join(tmpdir(), 'authority-edges-'))
  onTestFinished(() => { fs.rmSync(home, { recursive: true, force: true }) })
  const root = join(home, 'tree')
  fs.mkdirSync(root, { mode: 0o700 })
  return { home, root }
}

function missing(): Error {
  return Object.assign(new Error('Entry disappeared'), { code: 'ENOENT' })
}

function finish(root: string): void {
  for (const _step of checkAuthoritativeTree(root)) { /* Drain the cooperative review. */ }
}

describe('authoritative tree structure edge observations', () => {
  it('leaves Windows trees to the sandbox write exclusion', () => {
    const stat = vi.spyOn(fs, 'lstatSync')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    finish('/unused/tree')
    expect(stat).not.toHaveBeenCalled()
  })

  it('rejects when the host cannot identify its user', () => {
    const { root } = fixture()
    vi.stubGlobal('process', Object.assign(Object.create(process), { getuid: undefined }))
    try { expect(() => { finish(root) }).toThrow(root) } finally { vi.unstubAllGlobals() }
  })

  it('accepts an absent tree but propagates an unreadable root', () => {
    const { root } = fixture()
    fs.rmdirSync(root)
    expect(() => { finish(root) }).not.toThrow()
    const failure = Object.assign(new Error('Root denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw failure })
    expect(() => { finish(root) }).toThrow(failure)
  })

  it('rejects a regular-file root and a canonical directory alias', () => {
    const { home, root } = fixture()
    const file = join(home, 'file')
    fs.writeFileSync(file, 'state')
    expect(() => { finish(file) }).toThrow(file)
    const alias = join(home, 'alias')
    fs.symlinkSync(root, alias)
    expect(() => { finish(alias) }).toThrow(alias)
    const resolve = fs.realpathSync
    vi.spyOn(fs, 'realpathSync').mockImplementation((...args) => String(args[0]) === root ? home : resolve(...args))
    expect(() => { finish(root) }).toThrow(root)
  })

  it('ignores names removed after enumeration and directories removed before listing', () => {
    const { root } = fixture()
    const file = join(root, 'gone')
    fs.writeFileSync(file, 'state')
    const review = checkAuthoritativeTree(root)
    expect(review.next().done).toBe(false)
    fs.unlinkSync(file)
    expect(() => [...review]).not.toThrow()
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw missing() })
    expect(() => { finish(root) }).not.toThrow()
  })

  it('propagates nonmissing directory and symlink resolution failures', () => {
    const { root } = fixture()
    const failure = Object.assign(new Error('Observation denied'), { code: 'EACCES' })
    const listing = vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw failure })
    expect(() => { finish(root) }).toThrow(failure)
    listing.mockRestore()
    const link = join(root, 'link')
    fs.symlinkSync(join(root, 'missing'), link)
    expect(() => { finish(root) }).toThrow(link)
    const resolve = fs.realpathSync
    vi.spyOn(fs, 'realpathSync').mockImplementation((...args) => {
      if (String(args[0]) === link) throw failure
      return resolve(...args)
    })
    expect(() => { finish(root) }).toThrow(failure)
  })

  it('rejects writable entries, foreign owners, and nonregular entry types', () => {
    const { root } = fixture()
    const file = join(root, 'state')
    fs.writeFileSync(file, 'state', { mode: 0o600 })
    fs.chmodSync(file, 0o622)
    expect(() => { finish(root) }).toThrow(file)
    fs.chmodSync(file, 0o600)
    const stat = fs.lstatSync
    const mocked = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      const entry = stat(...args)
      if (entry === undefined) return entry
      return String(args[0]) === file ? Object.assign(entry, { uid: BigInt((process.getuid?.() ?? 0) + 1) }) : entry
    })
    expect(() => { finish(root) }).toThrow(file)
    mocked.mockImplementation((...args) => {
      const entry = stat(...args)
      if (entry === undefined) return entry
      return String(args[0]) === file ? Object.assign(entry, { isFile: () => false }) : entry
    })
    expect(() => { finish(root) }).toThrow(file)
  })

  it('accepts an internal root link and rejects parent, sibling, and nested outside targets', () => {
    const { home, root } = fixture()
    const link = join(root, 'link')
    fs.symlinkSync(root, link)
    expect(() => { finish(root) }).not.toThrow()
    for (const target of [home, join(home, 'sibling'), join(home, 'nested', 'outside')]) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.unlinkSync(link)
      fs.symlinkSync(target, link)
      expect(() => { finish(root) }).toThrow(link)
    }
  })

  it('does not count a vanished or replaced file as a live hard link', () => {
    const { root } = fixture()
    const file = join(root, 'state')
    fs.writeFileSync(file, 'state', { mode: 0o600 })
    for (const replacement of [false, true]) {
      const review = checkAuthoritativeTree(root)
      expect(review.next().done).toBe(false)
      expect(review.next().done).toBe(false)
      fs.unlinkSync(file)
      if (replacement) fs.mkdirSync(file)
      expect(() => [...review]).not.toThrow()
      if (replacement) fs.rmdirSync(file)
      fs.writeFileSync(file, 'next', { mode: 0o600 })
    }
  })

  it.each(['absent', 'file', 'identity', 'owner', 'permissions', 'canonical'] as const)(
    'checks the final root observation after traversal: %s', (kind) => {
      const { home, root } = fixture()
      const review = checkAuthoritativeTree(root)
      expect(review.next().done).toBe(false)
      if (kind === 'absent') fs.rmdirSync(root)
      if (kind === 'file') { fs.rmdirSync(root); fs.writeFileSync(root, 'replaced') }
      if (kind === 'identity') {
        fs.renameSync(root, join(home, 'old-tree'))
        fs.mkdirSync(root, { mode: 0o700 })
      }
      if (kind === 'owner') {
        const stat = fs.lstatSync
        vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
          const entry = stat(...args)
          return entry === undefined ? entry : Object.assign(entry, { uid: BigInt((process.getuid?.() ?? 0) + 1) })
        })
      }
      if (kind === 'permissions') fs.chmodSync(root, 0o722)
      if (kind === 'canonical') vi.spyOn(fs, 'realpathSync').mockReturnValue(home)
      if (kind === 'absent') expect(() => [...review]).not.toThrow()
      else expect(() => [...review]).toThrow(root)
    },
  )
})
