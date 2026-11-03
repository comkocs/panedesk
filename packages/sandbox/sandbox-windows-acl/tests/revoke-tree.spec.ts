/** Revocation inventories durable ACE locations and verifies removal before reporting success. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { revokeWorkspaceTree } from '../src/revoke-tree.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-revoke-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const child = join(root, 'node_modules', 'package')
  mkdirSync(child, { recursive: true })
  const file = join(child, 'index.js')
  writeFileSync(file, 'export {}\n')
  const entries = new Set([root, child, file])
  const access = {
    hasExplicit: vi.fn((path: string) => entries.has(path)),
    removeExplicit: vi.fn((path: string) => { entries.delete(path) }),
    permits: vi.fn((_path: string, _mask: number) => false),
  }
  return { root, child, file, entries, access }
}

it('finds file and directory grants without any process-local history', () => {
  const f = fixture()
  expect(revokeWorkspaceTree(f.root, f.access)).toEqual([f.root, f.child, f.file])
  expect(f.entries.size).toBe(0)
  expect(f.access.hasExplicit.mock.calls.map(([path]) => path)).toEqual([
    f.root, join(f.root, 'node_modules'), f.child, f.file,
  ])
  for (const path of [f.root, f.child, f.file]) {
    for (const mask of [2, 4, 0x10000, 0x40]) expect(f.access.permits).toHaveBeenCalledWith(path, mask)
    expect(f.access.permits).toHaveBeenCalledWith(dirname(path), 0x40)
  }
})

it.each([2, 4, 0x10000, 0x40])('rejects remaining access mask %s after all explicit entries are removed', (mask) => {
  const f = fixture()
  f.access.permits.mockImplementation((path, desired) => path === f.child && desired === mask)
  expect(() => revokeWorkspaceTree(f.root, f.access)).toThrow('left write access')
  expect(f.entries.size).toBe(0)
})

it('rejects deletion through a parent even when every matched object denies DELETE', () => {
  const f = fixture()
  f.access.permits.mockImplementation((path, mask) => path === dirname(f.root) && mask === 0x40)
  expect(() => revokeWorkspaceTree(f.root, f.access)).toThrow('parent delete-child access')
})

it('retains failure when descriptor removal or verification fails', () => {
  const f = fixture()
  f.access.removeExplicit.mockImplementation(() => { throw new Error('native removal failed') })
  expect(() => revokeWorkspaceTree(f.root, f.access)).toThrow('native removal failed')
  expect(f.access.permits).not.toHaveBeenCalled()
  expect(f.entries.size).toBe(3)
})

it('inspects a link object without traversing its target a second time', () => {
  const f = fixture()
  const link = join(f.root, 'linked-package')
  symlinkSync(f.child, link, 'junction')
  f.entries.add(link)
  expect(revokeWorkspaceTree(f.root, f.access)).toContain(link)
  expect(f.access.hasExplicit).toHaveBeenCalledWith(link)
  expect(f.access.hasExplicit).not.toHaveBeenCalledWith(join(link, 'index.js'))
  expect(f.entries.size).toBe(0)
})
