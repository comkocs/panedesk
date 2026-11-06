/** Isolated owner review must not replace a trusted baseline after revocation. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

it('does not persist an isolated candidate when its owner revokes during confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-epoch-review-'))
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
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await ctx.permissionPresets.authorizeWorkspaceWrite(workspace)
  platform.mockRestore()
  const record = join(home, 'windows-workspace-write', 'protected-inputs', `${createHash('sha256').update(workspace).digest('hex')}.json`)
  const before = readFileSync(record, 'utf8')
  const reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(workspace, home)
  profile.inputIntegrity = reader
  writeFileSync(patch, 'changed')
  let confirmed = false
  const result = await Promise.allSettled([reader.verify({ blocked() {}, confirm: async () => {
    confirmed = true
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try { await ctx.permissionPresets.revokeWorkspaceWrite(workspace) } finally { platform.mockRestore() }
    return true
  } })])
  expect(confirmed).toBe(true)
  expect(readFileSync(record, 'utf8')).toBe(before)
  expect(result[0]?.status).toBe('rejected')
  expect(ctx.sandboxPolicy.workspaceAccess.isAuthorized(workspace)).toBe(false)
})
