/** Owner settings manage durable Windows grants without granting native ACEs on inspection. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import SessionStore from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import PermissionPresetService from '../src/index.ts'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: vi.fn() }
})

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function fixture(platform: NodeJS.Platform = 'win32') {
  const parent = mkdtempSync(join(tmpdir(), 'workspace-settings-'))
  homes.push(parent)
  const home = join(parent, 'workspace')
  mkdirSync(home)
  vi.stubEnv('PANEDESK_HOME', join(parent, 'owner-home'))
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService)
  ctx.provide('shell', { sandboxMode: ctx.sandboxPolicy.defaultMode })
  ctx.provide('approval', { config: { policy: 'ask' } })
  const revoke = vi.fn()
  const inspect = vi.fn(() => false)
  ctx.provide('sandbox', { supportsWorkspaceWriteAccess: true, hasWorkspaceWriteGrant: inspect, revokeWorkspaceWriteGrant: revoke })
  await ctx.plugin(PermissionPresetService, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  } })
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  return { ctx, home, revoke, inspect }
}

describe('Windows workspace settings', () => {
  it('lists, preauthorizes and revokes the exact selected directory', async () => {
    const { ctx, home, revoke, inspect } = await fixture()
    expect(await ctx.permissionPresets.workspaceWriteAccess()).toEqual({ supported: true, entries: [] })
    expect(inspect).not.toHaveBeenCalled()
    await ctx.permissionPresets.authorizeWorkspaceWrite(home)
    const view = await ctx.permissionPresets.workspaceWriteAccess()
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]?.grantedAt).toEqual(expect.any(String))
    expect(view.entries[0]).toEqual({ workspace: home, source: 'settings-preauthorization', grantedAt: view.entries[0]?.grantedAt })
    await ctx.permissionPresets.revokeWorkspaceWrite(home)
    expect(revoke).toHaveBeenCalledWith(home)
    expect(ctx.sandboxPolicy.workspaceAccess.find(home)).toBeUndefined()
  })
  it('notifies inventory readers after consent and revocation commit', async () => {
    const { ctx, home } = await fixture()
    const states: boolean[] = []
    ctx.on('permission-presets/workspace-write-changed', () => {
      states.push(ctx.sandboxPolicy.workspaceAccess.isAuthorized(home))
    })
    await ctx.permissionPresets.authorizeWorkspaceWrite(home)
    await ctx.permissionPresets.revokeWorkspaceWrite(home)
    expect(states).toEqual([true, false])
  })
  it('lets the owner remove consent for a deleted directory without a native ACL call', async () => {
    const { ctx, home, revoke } = await fixture()
    const workspace = join(home, 'deleted')
    mkdirSync(workspace)
    await ctx.permissionPresets.authorizeWorkspaceWrite(workspace)
    rmSync(workspace, { recursive: true })
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toHaveLength(1)
    await ctx.permissionPresets.revokeWorkspaceWrite(workspace)
    expect(revoke).not.toHaveBeenCalled()
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toEqual([])
  })
  it('discovers unrecorded legacy grants from live and cold session directories without granting', async () => {
    const { ctx, home, inspect, revoke } = await fixture()
    ctx.provide('sessionPersistence', { list: async () => [{ header: { cwd: home } }] })
    inspect.mockReturnValue(true)
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toEqual([{ workspace: home, source: 'legacy' }])
    expect(inspect).toHaveBeenCalledWith(home)
    expect(revoke).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })
  it('rejects management without an authenticated owner', async () => {
    const { ctx, home, revoke, inspect } = await fixture()
    Object.defineProperty(ctx, 'invocation', { value: undefined })
    await expect(ctx.permissionPresets.workspaceWriteAccess()).rejects.toThrow('authenticated owner')
    await expect(ctx.permissionPresets.authorizeWorkspaceWrite(home)).rejects.toThrow('authenticated owner')
    await expect(ctx.permissionPresets.revokeWorkspaceWrite(home)).rejects.toThrow('authenticated owner')
    expect(revoke).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })
  it('keeps a failed native revocation visible and retryable', async () => {
    const { ctx, home, revoke } = await fixture()
    await ctx.permissionPresets.authorizeWorkspaceWrite(home)
    revoke.mockImplementationOnce(() => { throw new Error('native ACL denied') })
    await expect(ctx.permissionPresets.revokeWorkspaceWrite(home)).rejects.toThrow('native ACL denied')
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toHaveLength(1)
  })
  it('lists an interrupted unrecorded revocation even without history or a remaining ACE', async () => {
    const { ctx, home, revoke, inspect } = await fixture()
    revoke.mockImplementationOnce(() => { throw new Error('native ACL unavailable') })
    await expect(ctx.permissionPresets.revokeWorkspaceWrite(home)).rejects.toThrow('native ACL unavailable')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toEqual([
      { workspace: home, source: 'revocation-pending' },
    ])
    expect(inspect).not.toHaveBeenCalled()
    await expect(ctx.permissionPresets.authorizeWorkspaceWrite(home)).rejects.toThrow('revocation')
    await ctx.permissionPresets.revokeWorkspaceWrite(home)
    expect((await ctx.permissionPresets.workspaceWriteAccess()).entries).toEqual([])
  })
  it('does not expose ACL management for a custom runner even when methods exist', async () => {
    const { ctx, home, revoke, inspect } = await fixture()
    Object.defineProperty(ctx.sandbox, 'supportsWorkspaceWriteAccess', { value: false })
    expect(await ctx.permissionPresets.workspaceWriteAccess()).toEqual({ supported: false, entries: [] })
    await expect(ctx.permissionPresets.authorizeWorkspaceWrite(home)).rejects.toThrow('Windows')
    await expect(ctx.permissionPresets.revokeWorkspaceWrite(home)).rejects.toThrow('Windows')
    expect(inspect).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })
  it('does not expose Windows authorization writes on another platform', async () => {
    const { ctx, home, revoke } = await fixture('linux')
    expect(await ctx.permissionPresets.workspaceWriteAccess()).toEqual({ supported: false, entries: [] })
    await expect(ctx.permissionPresets.authorizeWorkspaceWrite(home)).rejects.toThrow('Windows')
    await expect(ctx.permissionPresets.revokeWorkspaceWrite(home)).rejects.toThrow('Windows')
    expect(revoke).not.toHaveBeenCalled()
  })
})
