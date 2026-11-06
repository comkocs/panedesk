/** Native materialization has its own epoch barrier, independent of argv publication. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import PermissionPresetService from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'

const { createAcl } = vi.hoisted(() => ({ createAcl: vi.fn(() => ({ add() {}, protect() {}, has: () => true, dispose() {} })) }))
vi.mock('@panedesk/dsh-sandbox-windows-acl', async original => ({
  ...await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>(), assertWindowsStateTrusted: vi.fn(),
  AclWriteGrant: { create: createAcl },
}))

it('rejects old native materialization after a newer owner grant without creating an ACL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-epoch-native-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  const dir = join(workspace, 'profile')
  mkdirSync(dir, { recursive: true })
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
  await ctx.plugin(LocalSandboxProvider, { runnerCommand: ['test-runner'], runnerFailureSignatures: ['test runner refused'] })
  vi.spyOn(ctx.sandbox, 'supportsWorkspaceWriteAccess', 'get').mockReturnValue(true)
  vi.spyOn(ctx.sandbox, 'hasWorkspaceWriteGrant').mockReturnValue(false)
  vi.spyOn(ctx.sandbox, 'revokeWorkspaceWriteGrant').mockImplementation(() => {})
  await ctx.plugin(PermissionPresetService, { defaultPreset: 'workspace-write' })
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  await ctx.permissionPresets.authorizeWorkspaceWrite(workspace)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // The mock supplies the original receiver explicitly through call.
  // oxlint-disable-next-line typescript/unbound-method
  const original = ProtectedInputIntegrity.prototype.waitForCapture
  vi.spyOn(ProtectedInputIntegrity.prototype, 'waitForCapture').mockImplementation(async function (this: ProtectedInputIntegrity) {
    await original.call(this)
    entered.resolve(undefined)
    await release.promise
  })
  const pending = Promise.allSettled([ctx.sandbox.materializeWorkspaceWriteGrant!({
    mode: 'workspace-write', workspaceRoot: workspace, sessionId: SessionId('old-native'),
  })])
  await entered.promise
  try {
    await ctx.permissionPresets.revokeWorkspaceWrite(workspace)
    await ctx.permissionPresets.authorizeWorkspaceWrite(workspace)
  } finally { release.resolve(undefined) }
  expect((await pending)[0]?.status).toBe('rejected')
  expect(createAcl).not.toHaveBeenCalled()
  expect(ctx.sandboxPolicy.workspaceAccess.isAuthorized(workspace)).toBe(true)
})
