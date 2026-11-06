/** Ordinary session admission never replaces an owner-approved workspace baseline. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import { LocalSandboxProvider } from '../../../sandbox/sandbox-local/src/index.ts'
import PermissionPresetService from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async original => ({
  ...await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>(), assertWindowsStateTrusted: vi.fn(),
}))

async function fixture(windows = false) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-trust-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const dir = join(workspace, 'profile')
  mkdirSync(dir)
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(patch, 'approved input')
  const home = join(root, 'owner')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  if (windows) vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace, mode: 'workspace-write' })
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' } })
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: patch, home, cwd: workspace,
    installAnchor: join(workspace, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  ctx.provide('sandbox', {
    supportsWorkspaceWriteAccess: true, hasWorkspaceWriteGrant: () => false, revokeWorkspaceWriteGrant: async () => {},
  })
  await ctx.plugin(PermissionPresetService, { defaultPreset: 'workspace-write' })
  const session = (id: string) => ctx.sessions.prepare(SessionId(id), { meta: { cwd: workspace } })
  return { ctx, workspace, patch, home, profile, session }
}

it('captures once when two sessions initialize the same workspace in sequence', async () => {
  const f = await fixture()
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite')
  await f.ctx.permissionPresets.initialize(f.session('first'))
  const reader = [...f.profile.inputIntegrities?.values() ?? []][0]
  await f.ctx.permissionPresets.initialize(f.session('second'))
  expect(capture).toHaveBeenCalledTimes(1)
  expect([...f.profile.inputIntegrities?.values() ?? []]).toEqual([reader])
})

it('refuses a new session after protected content changes without replacing trusted bytes', async () => {
  const f = await fixture()
  await f.ctx.permissionPresets.initialize(f.session('first'))
  writeFileSync(f.patch, 'unapproved input')
  const next = f.session('second')
  await expect(f.ctx.permissionPresets.initialize(next)).rejects.toThrow('Protected')
  expect(next.snapshotEvents()).toEqual([])
  expect(new ProtectedInputIntegrity(f.workspace, f.home).readTrusted(f.patch)?.toString()).toBe('approved input')
})

it('accepts explicit owner reauthorization only after capture and blocks write admission meanwhile', async () => {
  const f = await fixture(true)
  await f.ctx.permissionPresets.initialize(f.session('first'))
  writeFileSync(f.patch, 'owner replacement')
  const denied = f.session('denied')
  await expect(f.ctx.permissionPresets.initialize(denied)).rejects.toThrow('Protected')
  const capture = vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite')
  Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'automation' } } } })
  await expect(f.ctx.permissionPresets.authorizeWorkspaceWrite(f.workspace)).rejects.toThrow('authenticated owner')
  expect(capture).not.toHaveBeenCalled()
  Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  const nativeGrant = vi.spyOn(f.ctx.sandbox, 'hasWorkspaceWriteGrant').mockReturnValue(true)
  await expect(f.ctx.permissionPresets.authorizeWorkspaceWrite(f.workspace)).rejects.toThrow('Revoke')
  expect(capture).not.toHaveBeenCalled()
  nativeGrant.mockReturnValue(false)
  const sandboxContext = new Context()
  onTestFinished(async () => { await sandboxContext.fiber.dispose() })
  sandboxContext.provide('profileContext', f.profile)
  await sandboxContext.plugin(LocalSandboxProvider, {
    runnerCommand: ['test-runner'], runnerFailureSignatures: ['test runner refused'],
  })
  const pending = f.ctx.permissionPresets.authorizeWorkspaceWrite(f.workspace)
  const reader = [...f.profile.inputIntegrities?.values() ?? []][0]
  if (reader === undefined) throw new Error('Missing workspace reader')
  expect(reader.covers(f.patch)).toBe(false)
  expect(f.ctx.sandboxPolicy.workspaceAccess.isAuthorized(f.workspace)).toBe(false)
  let sandboxStarted = false
  const sandbox = sandboxContext.sandbox.confine(['test-command'], {
    mode: 'workspace-write', workspaceRoot: f.workspace,
  }).then(() => { sandboxStarted = true })
  expect(sandboxStarted).toBe(false)
  await pending
  await sandbox
  expect(sandboxStarted).toBe(true)
  expect(f.ctx.sandboxPolicy.workspaceAccess.isAuthorized(f.workspace)).toBe(true)
  expect(capture).toHaveBeenCalledTimes(1)
  expect(reader.readTrusted(f.patch)?.toString()).toBe('owner replacement')
  await expect(f.ctx.permissionPresets.initialize(f.session('after-owner'))).resolves.toBeUndefined()
})
