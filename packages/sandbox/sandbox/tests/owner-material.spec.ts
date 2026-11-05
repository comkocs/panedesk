/** Owner storage checks retain path, identity, and recursive isolation guarantees. */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertOwnerWorkspace, isOwnerMaterial, isolatedOwnerPaths, ownerMaterialDirectories } from '../src/owner-material.ts'

const directories: string[] = []
afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-inventory-'))
  directories.push(root)
  const owner = join(root, 'private')
  mkdirSync(owner)
  return { root, owner }
}

it('deduplicates canonical owner roots and desktop registrations', () => {
  const { root, owner } = fixture()
  const alias = join(root, 'alias')
  symlinkSync(owner, alias, 'junction')
  expect(ownerMaterialDirectories([owner, alias], JSON.stringify([owner, alias])))
    .toEqual([owner, alias, realpathSync(owner)].filter((path, index, paths) => paths.indexOf(path) === index).sort())
  expect(ownerMaterialDirectories([owner])).toEqual([owner])
})

it.each(['{}', '[1]', '[null]', 'true', 'null'])('rejects invalid desktop registrations %s', (serialized) => {
  expect(() => ownerMaterialDirectories([], serialized)).toThrow('Desktop private paths must be a JSON string array')
})

it('rejects malformed desktop registration JSON', () => {
  expect(() => ownerMaterialDirectories([], '[')).toThrow(SyntaxError)
})

it('refuses nested owner workspaces and Windows ancestor write grants only', () => {
  const { root, owner } = fixture()
  expect(() => { assertOwnerWorkspace(owner, [owner]) }).toThrow('dedicated directory')
  expect(() => { assertOwnerWorkspace(join(owner, 'nested'), [owner], true) }).toThrow('dedicated directory')
  expect(() => { assertOwnerWorkspace(root, [owner], true) }).toThrow('workspace contains an owner private directory')
  expect(() => { assertOwnerWorkspace(root, [owner]) }).not.toThrow()
  expect(() => { assertOwnerWorkspace(join(root, 'private-sibling'), [owner], true) }).not.toThrow()
  expect(() => { assertOwnerWorkspace(join(root, '..', 'elsewhere'), [owner], true) }).not.toThrow()
  expect(() => { assertOwnerWorkspace(root, []) }).not.toThrow()
})

it('matches absent descendants by path and rejects unrelated absent paths', () => {
  const { root, owner } = fixture()
  expect(isOwnerMaterial(join(owner, 'missing'), [owner])).toBe(true)
  expect(isOwnerMaterial(join(root, 'missing'), [owner])).toBe(false)
  const ordinary = join(root, 'ordinary')
  writeFileSync(ordinary, 'ordinary')
  expect(isOwnerMaterial(ordinary, [join(root, 'absent')])).toBe(false)
  expect(isOwnerMaterial(ordinary, [])).toBe(false)
})

it('walks recursive identities once across aliases and distinguishes device and inode', () => {
  const { root, owner } = fixture()
  const nested = join(owner, 'nested')
  mkdirSync(nested)
  const document = join(nested, 'document')
  writeFileSync(document, 'synthetic owner document')
  symlinkSync(nested, join(owner, 'alias'), 'junction')
  symlinkSync(owner, join(nested, 'cycle'), 'junction')
  const ordinary = join(root, 'ordinary')
  writeFileSync(ordinary, 'ordinary')
  expect(isOwnerMaterial(ordinary, [owner])).toBe(false)
  const hard = join(root, 'hard')
  linkSync(document, hard)
  expect(isOwnerMaterial(hard, [owner])).toBe(true)
  expect(isOwnerMaterial(ordinary, [owner], { dev: -1n, ino: -1n })).toBe(false)
})

it('creates missing owner roots and records external symbolic targets without revisiting cycles', () => {
  const { root, owner } = fixture()
  const external = join(root, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'document'), 'synthetic owner document')
  symlinkSync(external, join(owner, 'external'), 'junction')
  symlinkSync(owner, join(owner, 'cycle'), 'junction')
  const missing = join(root, 'missing')
  expect(new Set(isolatedOwnerPaths([owner, owner, missing])))
    .toEqual(new Set([owner, external, missing]))
})

it('refuses hard-linked owner documents and preserves the underlying inspection error', () => {
  const { root, owner } = fixture()
  const document = join(owner, 'document')
  writeFileSync(document, 'synthetic owner document')
  linkSync(document, join(root, 'alias'))
  expect(() => isolatedOwnerPaths([owner])).toThrow('Owner identity material cannot be isolated')
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'file')
  expect(() => isolatedOwnerPaths([join(blocker, 'private')])).toThrow('Owner identity material cannot be isolated')
})

it('refuses non-file owner entries reported by the filesystem', async () => {
  const { owner } = fixture()
  vi.doMock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>()
    return { ...fs, statSync: () => ({ isFile: () => false, isDirectory: () => false }) }
  })
  const { isolatedOwnerPaths: inspect } = await import('../src/owner-material.ts')
  expect(() => inspect([owner])).toThrow('Owner identity material cannot be isolated')
})
