/** Host authority content exclusions never widen native sandbox write permissions. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { rootsOverlap } from '@panedesk/dsh-sandbox'
import { AclWriteGrant } from '@panedesk/dsh-sandbox-windows-acl'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'
import { protectAclInputs } from '../src/protected-acl.ts'

const protects = vi.hoisted(() => vi.fn())
vi.mock('@panedesk/dsh-sandbox-windows-acl', () => ({
  AclWriteGrant: class {
    static create() { return new this() }
    protect = protects
    dispose() {}
  },
}))

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'authority-write-'))
  const home = join(workspace, '.panedesk')
  const roots = ['ledger', 'sessions', 'storages/session_projcache/sessions', 'windows-workspace-write']
    .map(path => join(home, path))
  for (const root of roots) mkdirSync(root, { recursive: true, mode: 0o700 })
  onTestFinished(() => { rmSync(workspace, { recursive: true, force: true }) })
  return { workspace, home, roots, policy: { mode: 'workspace-write' as const, workspaceRoot: workspace, protectedPaths: [home] } }
}

it('Linux profiles keep all authority trees outside writable grants', () => {
  const f = fixture()
  const bwrap = bwrapProfileArgs(f.policy)
  expect(bwrap.join('\n')).toContain(['--ro-bind', f.home, f.home].join('\n'))
  const writable = join(f.workspace, 'output')
  mkdirSync(writable)
  const landlock = landlockProfileArgs(f.policy)
  const grants = landlock.flatMap((value, index) => value === '--rw' ? [landlock[index + 1]] : [])
  expect(grants).toContain(writable)
  for (const grant of grants) {
    if (grant === undefined) throw new Error('Missing Landlock write-grant path')
    expect(rootsOverlap(grant, f.home)).toBe(false)
    for (const root of f.roots) expect(rootsOverlap(grant, root)).toBe(false)
  }
})

it('macOS profiles deny writes to the home branch containing all authority trees', () => {
  const f = fixture()
  expect(seatbeltProfileArgs(f.policy)[1]).toContain(`(deny file-write* (subpath ${JSON.stringify(f.home)}))`)
})

it('Windows capabilities deny recursive writes to the home branch and authorization records', () => {
  const f = fixture()
  protects.mockClear()
  const grant = AclWriteGrant.create('authority-fixture')
  protectAclInputs(grant, f.workspace, [f.home, ...f.roots])
  expect(protects.mock.calls).toEqual([[f.home], ...f.roots.map(root => [root]),
    [f.home, false], [join(f.home, 'storages', 'session_projcache'), false], [join(f.home, 'storages'), false]])
  grant.dispose()
})
