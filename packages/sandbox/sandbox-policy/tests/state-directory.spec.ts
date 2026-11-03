/** Owner state is excluded before a workspace can receive native write access. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { WorkspaceWriteAccess } from '../src/workspace-access.ts'
import SandboxPolicyService from '../src/index.ts'

it.each(['linux', 'darwin'] as const)('protects the first workspace child and creates owner state before %s writes', async (platform) => {
  const workspace = mkdtempSync(join(tmpdir(), 'state-directory-'))
  const home = join(workspace, '.panedesk', 'nested')
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(workspace, { recursive: true, force: true })
  })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace })
  const policy = ctx.sandboxPolicy.resolve()
  expect(policy.mode).toBe('workspace-write')
  expect(policy.protectedPaths).toContain(join(workspace, '.panedesk'))
  expect(policy.protectedPaths).not.toContain(workspace)
  expect(existsSync(join(home, 'windows-workspace-write'))).toBe(true)
  await expect(ctx.sandboxPolicy.workspaceAccess.authorize(workspace, 'settings-preauthorization'))
    .resolves.toMatchObject({ workspace })
})

it('resolves a linked home before choosing the first protected workspace child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'state-home-link-'))
  const workspace = join(root, 'workspace')
  const actual = join(workspace, '.panedesk', 'nested')
  const alias = join(root, 'home-alias')
  mkdirSync(actual, { recursive: true })
  symlinkSync(actual, alias, 'junction')
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', alias)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace, mode: 'workspace-write' })
  expect(ctx.sandboxPolicy.resolve().protectedPaths).toContain(join(workspace, '.panedesk'))
  expect(existsSync(join(actual, 'windows-workspace-write'))).toBe(true)
})

it('refuses Windows state-containing workspace consent with actionable bilingual guidance', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'windows-state-consent-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
  const access = new WorkspaceWriteAccess(join(workspace, '.panedesk'))
  await expect(access.authorize(workspace, 'first-confirmation')).rejects.toThrow(
    'The workspace contains the Panedesk state directory; choose one of its subdirectories. / 工作区包含 Panedesk 状态目录，请选它的子目录。',
  )
  expect(access.find(workspace)).toBeUndefined()
})
