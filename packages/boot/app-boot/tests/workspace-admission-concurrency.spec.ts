/** Workspace admission shares only requests enrolled before scanning and isolates cancellation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { grantProtectedWorkspace } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-admission-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const patch = join(workspace, 'cordis.patch.yml')
  writeFileSync(patch, 'approved')
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const profile: ProfileContext = {
    name: 'test', cwd: workspace, home, dir: workspace, patchPath: patch,
    installAnchor: join(workspace, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  return { profile, workspace, patch }
}

it('captures once without a second review for requests enrolled before scanning', async () => {
  const f = fixture()
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite')
  const review = vi.spyOn(ProtectedInputIntegrity.prototype, 'verify')
  await Promise.all([
    grantProtectedWorkspace(f.profile, f.workspace, []),
    grantProtectedWorkspace(f.profile, f.workspace, []),
  ])
  expect(capture).toHaveBeenCalledTimes(1)
  expect(review).not.toHaveBeenCalled()
})

it('reviews an existing baseline once for requests enrolled before scanning', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  const review = vi.spyOn(ProtectedInputIntegrity.prototype, 'verify')
  await Promise.all([
    grantProtectedWorkspace(f.profile, f.workspace, []),
    grantProtectedWorkspace(f.profile, f.workspace, []),
  ])
  expect(review).toHaveBeenCalledTimes(1)
})

it('shares a refused review without replacing approved bytes', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  writeFileSync(f.patch, 'changed')
  const review = vi.spyOn(ProtectedInputIntegrity.prototype, 'verify')
  const results = await Promise.allSettled([
    grantProtectedWorkspace(f.profile, f.workspace, []),
    grantProtectedWorkspace(f.profile, f.workspace, []),
  ])
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(review).toHaveBeenCalledTimes(1)
  expect(new ProtectedInputIntegrity(f.workspace, f.profile.home).readTrusted(f.patch)?.toString()).toBe('approved')
})

it('runs a separate review for a request arriving after a file has been read', async () => {
  const f = fixture()
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  const review = vi.spyOn(ProtectedInputIntegrity.prototype, 'verify')
  const original = fs.openSync
  let later: Promise<void> | undefined
  const opened = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.patch && args[1] === 'r' && later === undefined) {
      later = grantProtectedWorkspace(f.profile, f.workspace, [])
    }
    return original(...args)
  })
  await grantProtectedWorkspace(f.profile, f.workspace, [])
  expect(later).toBeDefined()
  await later
  opened.mockRestore()
  expect(review).toHaveBeenCalledTimes(2)
  writeFileSync(f.patch, 'changed after both reviews')
  await expect(grantProtectedWorkspace(f.profile, f.workspace, [])).rejects.toThrow('Protected')
})

it('cancels one waiting request without cancelling its shared capture', async () => {
  const f = fixture()
  const controller = new AbortController()
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite')
  const first = grantProtectedWorkspace(f.profile, f.workspace, [], controller.signal)
  const rejected = expect(first).rejects.toThrow('withdrawn')
  const second = grantProtectedWorkspace(f.profile, f.workspace, [])
  controller.abort(new Error('withdrawn'))
  await rejected
  await second
  expect(capture).toHaveBeenCalledTimes(1)
  expect(new ProtectedInputIntegrity(f.workspace, f.profile.home).covers(f.patch)).toBe(true)
})
