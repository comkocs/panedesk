/** State trust follows the sandbox token, not a SID prefix or ACE inventory alone. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { inspectStateAncestors } from '../src/state-access.ts'
import type { FileAccessProbe } from '../src/state-access.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'state-access-'))
  const state = join(root, 'owner', 'state')
  mkdirSync(state, { recursive: true })
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const checks: { path: string; mask: number }[] = []
  const rights = new Map<string, number>()
  const probe: FileAccessProbe = {
    permits(path, mask) {
      checks.push({ path, mask })
      return ((rights.get(path) ?? 0) & mask) === mask
    },
  }
  return { root, state, rights, checks, probe }
}

it.each([2, 4, 0x10000, 0x40])('refuses state trust for ancestor access mask %s and trusts after removal', (mask) => {
  const f = fixture()
  f.rights.set(f.root, mask)
  expect(inspectStateAncestors(f.state, f.probe)).toEqual({ path: f.root, mask })
  f.rights.clear()
  expect(inspectStateAncestors(f.state, f.probe)).toBeUndefined()
})

it('checks every existing ancestor through the volume root without granting read-only ACEs write authority', () => {
  const f = fixture()
  f.rights.set(f.root, 1)
  expect(inspectStateAncestors(f.state, f.probe)).toBeUndefined()
  for (let path = f.state; ; path = dirname(path)) {
    expect(f.checks.filter(check => check.path === path).map(check => check.mask)).toEqual([2, 4, 0x10000, 0x40])
    if (dirname(path) === path) break
  }
})
