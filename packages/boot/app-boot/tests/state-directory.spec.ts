/** Durable state may be nested only behind a native first-child write exclusion. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'
import { grantProtectedWorkspace } from '../src/profile-context.ts'
import type { ProfileContext } from '../src/profile-context-types.ts'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async original => ({
  ...await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>(),
  assertWindowsStateTrusted: vi.fn(),
}))

it.each(['linux', 'darwin'] as const)('establishes nested owner state behind the first protected child on %s', async (platform) => {
  const workspace = mkdtempSync(join(tmpdir(), 'nested-owner-state-'))
  const home = join(workspace, '.panedesk', 'nested')
  const dir = join(home, 'profiles', 'active')
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const profile: ProfileContext = {
    name: 'active', home, dir, patchPath, cwd: workspace, installAnchor: join(dir, 'package.json'),
    overlays: [], startedBundles: [], telemetryDisabledEnv: undefined,
    protectedInputPaths: () => [join(workspace, '.panedesk')],
  }
  await expect(grantProtectedWorkspace(profile, workspace, [join(workspace, '.panedesk')])).resolves.toBeUndefined()
  const reopened = ProtectedInputIntegrity.openOwnerRecords(workspace, home)
  expect(reopened.readTrusted(patchPath)?.toString()).toBe('[]\n')
})

it.each(['linux', 'darwin'] as const)('retains sibling input baselines while excluding only record storage on %s', async (platform) => {
  const workspace = mkdtempSync(join(tmpdir(), 'sibling-owner-input-'))
  const home = join(workspace, '.panedesk')
  const storage = join(home, 'windows-workspace-write', 'protected-inputs')
  const input = join(home, 'plugin.js')
  mkdirSync(home)
  writeFileSync(input, 'export const value = 1\n')
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(home)
  await integrity.grantWrite([home])
  const reopened = ProtectedInputIntegrity.openOwnerRecords(workspace, home)
  expect(reopened.covers(input)).toBe(true)
  expect(reopened.readTrusted(input)?.toString()).toBe('export const value = 1\n')
  expect(reopened.readExecutable(input)?.toString()).toBe('export const value = 1\n')
  expect(reopened.covers(storage)).toBe(false)
  writeFileSync(join(storage, 'unrelated.new'), 'mutable record storage')
  const owner = { confirm: vi.fn(async () => false), blocked: vi.fn() }
  expect(await reopened.verify(owner)).toBe(true)
  expect(owner.confirm).not.toHaveBeenCalled()
  writeFileSync(input, 'export const value = 2\n')
  expect(reopened.readTrusted(input)?.toString()).toBe('export const value = 1\n')
  expect(() => reopened.readExecutable(input)).toThrow('requires owner confirmation')
  expect(await reopened.verify(owner)).toBe(false)
  expect(owner.blocked).toHaveBeenCalledTimes(1)
})

it('opens a Windows read-only session with nested state without granting write access', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'readonly-owner-state-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const integrity = ProtectedInputIntegrity.openOwnerRecords(workspace, join(workspace, '.panedesk'))
  expect(integrity.covers(workspace)).toBe(false)
  expect(() => integrity.grantWrite()).toThrow('outside the writable workspace')
})
