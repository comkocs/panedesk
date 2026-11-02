/** Windows default denials retain their typed failure and explain owner preauthorization. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { FsError } from '@panedesk/dsh-fs'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import { FsSandboxController } from '../src/sandbox.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function controller(platform: NodeJS.Platform, mode?: 'read-only') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, mode === undefined ? {} : { mode })
  // Only the filesystem capability fact is needed by the error presenter.
  ctx.provide('fs', { sandboxMode: 'read-only' })
  return new FsSandboxController(ctx)
}

it('explains Windows default read-only refusal and the owner settings path without asking', async () => {
  const sandbox = await controller('win32')
  const denied = new FsError('denied', 'FS_SANDBOX_DENIED')
  const result = sandbox.mapError(denied, { mode: 'read-only', workspaceRoot: process.cwd() })
  expect(result).toBeInstanceOf(FsError)
  expect(result).toMatchObject({ code: 'FS_SANDBOX_DENIED', cause: denied })
  expect(result instanceof Error ? result.message : '').toContain('Windows defaults to read-only')
  expect(result instanceof Error ? result.message : '').toContain('Settings > General > Windows workspace write access')
  expect(result instanceof Error ? result.message : '').toContain('Unattended tasks cannot grant this access')
})

it.each(['linux', 'darwin'] as const)('keeps the existing %s denial hint', async (platform) => {
  const sandbox = await controller(platform)
  const result = sandbox.mapError(new FsError('denied', 'FS_SANDBOX_DENIED'), {
    mode: 'read-only', workspaceRoot: process.cwd(),
  })
  expect(result instanceof Error ? result.message : '').toContain('retry this exact operation once with sandbox_permissions')
  expect(result instanceof Error ? result.message : '').not.toContain('Windows defaults')
})

it('does not describe an explicit Windows read-only choice as a platform default', async () => {
  const sandbox = await controller('win32', 'read-only')
  const result = sandbox.mapError(new FsError('denied', 'FS_SANDBOX_DENIED'), {
    mode: 'read-only', workspaceRoot: process.cwd(),
  })
  expect(result instanceof Error ? result.message : '').not.toContain('Windows defaults')
})
