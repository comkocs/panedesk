/** Host-owned workspace readers isolate durable identities while retaining verified passes. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { grantProtectedWorkspace } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-reader-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const patch = join(workspace, 'cordis.patch.yml')
  writeFileSync(patch, 'approved')
  const profile: ProfileContext = {
    name: 'test', cwd: workspace, home, dir: workspace, patchPath: patch,
    installAnchor: join(workspace, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  return { root, workspace, home, patch, profile }
}

it('shares a durable reader across canonical workspace aliases', async () => {
  const f = fixture()
  const alias = join(f.root, 'alias')
  symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite')
  await grantProtectedWorkspace(f.profile, alias, [])
  expect(f.profile.inputIntegrities?.size).toBe(1)
  expect(capture).not.toHaveBeenCalled()
})

it('does not reuse a reader from another owner home even when its map is retained', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  const previous = [...f.profile.inputIntegrities?.values() ?? []][0]
  const next = { ...f.profile, home: join(f.root, 'other-owner') }
  await grantProtectedWorkspace(next, f.workspace, [])
  expect(new ProtectedInputIntegrity(f.workspace, next.home).covers(f.patch)).toBe(true)
  expect([...next.inputIntegrities?.values() ?? []]).not.toContain(previous)
})

it('does not reuse a memory-only reader as a durable grant', async () => {
  const f = fixture()
  f.profile.inputIntegrity = new ProtectedInputIntegrity(f.workspace)
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  expect([...f.profile.inputIntegrities?.values() ?? []]).not.toContain(f.profile.inputIntegrity)
  expect(new ProtectedInputIntegrity(f.workspace, f.home).covers(f.patch)).toBe(true)
})

it('does not reuse verified trust after the workspace directory is replaced', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  const reader = [...f.profile.inputIntegrities?.values() ?? []][0]
  renameSync(f.workspace, join(f.root, 'previous'))
  mkdirSync(f.workspace)
  writeFileSync(f.patch, 'replacement')
  await expect(grantProtectedWorkspace(f.profile, f.workspace, [])).rejects.toThrow('Protected')
  expect([...f.profile.inputIntegrities?.values() ?? []].filter(value => value !== reader)).toHaveLength(1)
})

it('verifies a reopened durable baseline instead of capturing changed content', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  writeFileSync(f.patch, 'changed')
  const reopened = { ...f.profile, inputIntegrities: new Map<string, ProtectedInputIntegrity>() }
  await expect(grantProtectedWorkspace(reopened, f.workspace, [])).rejects.toThrow('Protected')
  expect(new ProtectedInputIntegrity(f.workspace, f.home).readTrusted(f.patch)?.toString()).toBe('approved')
})
