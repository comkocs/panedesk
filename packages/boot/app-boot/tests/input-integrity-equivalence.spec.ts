/** Equivalent path validation and independent metadata samples during warm reviews. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
vi.mock('node:path', async original => ({ ...await original<typeof import('node:path')>() }))

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'input-equivalence-'))
  const workspace = path.join(root, 'home')
  const home = path.join(workspace, '.panedesk')
  const nested = path.join(home, 'profiles', 'nested')
  fs.mkdirSync(nested, { recursive: true })
  const file = path.join(nested, 'entry.js')
  fs.writeFileSync(file, 'export const value = 1')
  fs.linkSync(file, path.join(nested, 'hard.js'))
  fs.symlinkSync(file, path.join(nested, 'internal.js'))
  const outside = path.join(root, 'external.js')
  fs.writeFileSync(outside, 'export const value = 2')
  fs.symlinkSync(outside, path.join(nested, 'external.js'))
  fs.mkdirSync(path.join(home, 'messages'), { mode: 0o700 })
  fs.writeFileSync(path.join(home, 'messages', 'host.json'), '{}', { mode: 0o600 })
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(home)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await integrity.disposeReview()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, home, nested, file, outside, integrity }
}

it('avoids repeated relative resolution for normalized snapshot copies', async () => {
  const f = fixture()
  await f.integrity.grantWrite([f.home])
  const state = f.integrity.exportReviewState()
  const relative = vi.spyOn(path, 'relative')
  const restored = ProtectedInputIntegrity.fromReviewState(state)
  const copies = state.approved.flatMap(([, value]) => value.files ?? [])
  const copyCalls = relative.mock.calls.filter(([root, file]) => root === f.home && copies.some(copy => copy.path === file))
  // Normalized absolute copies need one separator-aware comparison each, not path.relative.
  expect(copyCalls).toHaveLength(0)
  expect(restored.readTrusted(f.file)?.toString()).toBe('export const value = 1')
})

it.each(['root', 'child', 'collision', 'trailing', 'dot', 'parent', 'escape', 'relative'] as const)(
  'retains relative containment semantics for %s copies', async (kind) => {
    const f = fixture()
    await f.integrity.grantWrite([f.home])
    const state = f.integrity.exportReviewState()
    const entry = state.approved[0]
    if (entry === undefined) throw new Error('Missing fixture snapshot')
    const candidates = {
      root: f.home, child: f.file, collision: `${f.home}-other/file`, trailing: `${f.home}/`,
      dot: `${f.home}/./file`, parent: `${f.home}/nested/../file`, escape: `${f.home}/../file`, relative: 'file',
    }
    const candidate = candidates[kind]
    entry[1].files = [{ path: candidate, content: '' }]
    const suffix = path.relative(f.home, candidate)
    const accepted = path.isAbsolute(candidate) && (suffix === ''
      || !path.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${path.sep}`))
    if (accepted) expect(() => ProtectedInputIntegrity.fromReviewState(state)).not.toThrow()
    else expect(() => ProtectedInputIntegrity.fromReviewState(state)).toThrow('Invalid protected input copy path')
  },
)

it.each(['stable', 'target', 'ancestor', 'links', 'ctime', 'addition', 'removal', 'authority'] as const)(
  'matches an uncached review after %s changes', async (kind) => {
    const f = fixture()
    await f.integrity.grantWrite([f.home])
    const full = new ProtectedInputIntegrity(f.workspace, f.home)
    switch (kind) {
      case 'stable': break
      case 'target':
        fs.unlinkSync(path.join(f.nested, 'internal.js'))
        fs.symlinkSync(f.outside, path.join(f.nested, 'internal.js'))
        break
      case 'ancestor': {
        const moved = path.join(f.root, 'moved')
        fs.renameSync(f.nested, moved)
        fs.symlinkSync(moved, f.nested)
        break
      }
      case 'links': fs.linkSync(f.file, path.join(f.root, 'extra-link')); break
      case 'ctime': {
        const before = fs.statSync(f.file)
        fs.utimesSync(f.file, before.atime, before.mtime)
        break
      }
      case 'addition': fs.writeFileSync(path.join(f.nested, 'new.js'), 'new'); break
      case 'removal': fs.unlinkSync(path.join(f.nested, 'hard.js')); break
      case 'authority': fs.writeFileSync(path.join(f.home, 'messages', 'new.json'), '{}', { mode: 0o600 }); break
    }
    const fastOwner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
    const fullOwner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
    const fastResult = await f.integrity.verify(fastOwner)
    const fullResult = await full.verify(fullOwner)
    expect(fastResult).toBe(fullResult)
    expect(fastResult).toBe(['stable', 'links', 'ctime', 'authority'].includes(kind))
    expect(fastOwner.blocked.mock.calls).toEqual(fullOwner.blocked.mock.calls)
  },
)

it('samples every warm file independently in both stability passes', async () => {
  const f = fixture()
  await f.integrity.grantWrite([f.home])
  const lstat = vi.spyOn(fs, 'lstatSync')
  const stat = vi.spyOn(fs, 'statSync')
  const native = vi.spyOn(fs.realpathSync, 'native')
  const relative = vi.spyOn(path, 'relative')
  expect(await f.integrity.verify({ blocked() {}, confirm: async () => false })).toBe(true)
  for (const file of [f.file, path.join(f.nested, 'external.js'), path.join(f.nested, 'hard.js'), path.join(f.nested, 'internal.js')]) {
    expect(lstat.mock.calls.filter(([name]) => name === file)).toHaveLength(2)
    expect(stat.mock.calls.filter(([name]) => name === file)).toHaveLength(2)
    expect(native.mock.calls.filter(([name]) => name === file)).toHaveLength(2)
  }
  expect(relative.mock.calls.length).toBeGreaterThan(0)
})
