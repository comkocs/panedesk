/** Session publication captures writable inputs before exposing the platform permission mode. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '../../../session/session-projection/src/index.ts'
import SandboxPolicyService from '../../../sandbox/sandbox-policy/src/index.ts'
import PermissionPresetService from '../../permission-presets/src/index.ts'
import ApprovalService from '../src/index.ts'
import { expect, it, vi } from 'vitest'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: vi.fn() }
})

it.each([
  ['linux', undefined, true], ['darwin', undefined, true], ['win32', undefined, false],
  ['linux', 'read-only', false], ['darwin', 'read-only', false], ['win32', 'read-only', false],
] as const)('captures inputs at session publication for %s / %s only when writable', async (platform, mode, captured) => {
  const root = mkdtempSync(join(tmpdir(), 'session-input-capture-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner-state')
  mkdirSync(workspace)
  const patch = join(workspace, 'cordis.patch.yml')
  writeFileSync(patch, 'approved before session publication')
  const ctx = new Context()
  const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace, ...mode === undefined ? {} : { mode } })
    ctx.provide('shell', { sandboxMode: ctx.sandboxPolicy.defaultMode })
    await ctx.plugin(ApprovalService)
    const profile: ProfileContext = {
      name: 'capture-timing', dir: workspace, patchPath: patch, installAnchor: join(workspace, 'package.json'),
      home, cwd: workspace, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    ctx.provide('profileContext', profile)
    await ctx.plugin(PermissionPresetService, {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      },
    })
    const session = ctx.sessions.create(SessionId('capture-timing'), { meta: { cwd: workspace } })
    await ctx.permissionPresets.initialize(session)
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe(captured ? 'workspace-write' : 'read-only')
    writeFileSync(patch, 'changed after session publication')
    const reader = new ProtectedInputIntegrity(workspace, home)
    expect(reader.covers(patch)).toBe(captured)
    expect(reader.readTrusted(patch)?.toString()).toBe(captured
      ? 'approved before session publication' : 'changed after session publication')
    if (captured) expect(() => reader.readExecutable(patch)).toThrow('requires owner confirmation')
    else expect(profile.inputIntegrities).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    platformSpy.mockRestore()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
