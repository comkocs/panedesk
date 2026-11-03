/** Loader-owned policy composition retains workspace consent across provider reloads without a model. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import { expect, it, vi } from 'vitest'

vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return { ...actual, assertWindowsStateTrusted: vi.fn() }
})

it('loads read-only policy, persists directory consent, reloads it, and observes native revocation', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.workspace-policy-'))
  const workspace = join(root, 'workspace')
  const contexts: Context[] = []
  try {
    await mkdir(workspace)
    vi.stubEnv('PANEDESK_HOME', root)
    vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      { name: 'cordis:projections' },
      { name: 'cordis:policy', config: { workspaceRoot: workspace } },
    ]))
    const load = async () => {
      const ctx = new Context()
      contexts.push(ctx)
      ctx.baseUrl = `${pathToFileURL(root).href}/`
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { include: Include, projections: SessionProjectionRegistry, policy: SandboxPolicyService })
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      return ctx
    }
    const first = await load()
    const modes = [first.sandboxPolicy.resolve().mode]
    await first.sandboxPolicy.workspaceAccess.authorize(workspace, 'settings-preauthorization')
    modes.push(first.sandboxPolicy.resolve().mode)
    await first.fiber.dispose()
    const second = await load()
    modes.push(second.sandboxPolicy.resolve().mode)
    const revoke = vi.fn()
    await second.sandboxPolicy.workspaceAccess.revoke(workspace, revoke)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(workspace)
    modes.push(second.sandboxPolicy.resolve().mode)
    expect(modes).toEqual(['read-only', 'workspace-write', 'workspace-write', 'read-only'])
    expect(second.sandboxPolicy.workspaceAccess.list()).toEqual([])
    await expect(second.sandboxPolicy.workspaceAccess.revoke(workspace, () => {
      throw new Error('native revocation interrupted')
    })).rejects.toThrow('native revocation interrupted')
    await second.fiber.dispose()
    const third = await load()
    expect(third.sandboxPolicy.workspaceAccess.pendingRevocations()).toEqual([workspace])
    expect(third.sandboxPolicy.resolve().mode).toBe('read-only')
    await third.sandboxPolicy.workspaceAccess.revoke(workspace, revoke)
    expect(third.sandboxPolicy.workspaceAccess.pendingRevocations()).toEqual([])
    await third.sandboxPolicy.workspaceAccess.authorize(workspace, 'settings-preauthorization')
    await rm(workspace, { recursive: true })
    const revokeDeleted = vi.fn()
    await third.sandboxPolicy.workspaceAccess.revoke(workspace, revokeDeleted)
    expect(revokeDeleted).not.toHaveBeenCalled()
    expect(third.sandboxPolicy.workspaceAccess.list()).toEqual([])
    await mkdir(workspace)
    expect(third.sandboxPolicy.resolve().mode).toBe('read-only')
  } finally {
    for (const ctx of contexts) await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
