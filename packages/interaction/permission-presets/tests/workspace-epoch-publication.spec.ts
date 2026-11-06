/** Revocation must prevent an earlier owner capture from publishing write authorization. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import SessionStore from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import PermissionPresetService from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async original => ({
  ...await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>(), assertWindowsStateTrusted: vi.fn(),
}))

it('does not publish an owner capture completed after workspace revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-epoch-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const dir = join(workspace, 'profile')
  mkdirSync(dir)
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(patch, 'approved')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
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
    supportsWorkspaceWriteAccess: true, hasWorkspaceWriteGrant: () => false, revokeWorkspaceWriteGrant: () => {},
  })
  await ctx.plugin(PermissionPresetService, { defaultPreset: 'workspace-write' })
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  const captured = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // The mock supplies the original receiver explicitly through apply.
  // oxlint-disable-next-line typescript/unbound-method
  const original = ProtectedInputIntegrity.prototype.grantWrite
  vi.spyOn(ProtectedInputIntegrity.prototype, 'grantWrite').mockImplementation(async function (this: ProtectedInputIntegrity, ...args) {
    await original.apply(this, args)
    captured.resolve(undefined)
    await release.promise
  })
  const pending = ctx.permissionPresets.authorizeWorkspaceWrite(workspace)
  const result = Promise.allSettled([pending])
  await captured.promise
  try {
    await ctx.permissionPresets.revokeWorkspaceWrite(workspace)
  } finally { release.resolve(undefined) }
  expect((await result)[0]?.status).toBe('rejected')
  expect(ctx.sandboxPolicy.workspaceAccess.isAuthorized(workspace)).toBe(false)
})
