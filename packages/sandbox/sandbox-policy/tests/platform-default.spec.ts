/** Platform defaults stay distinct from explicit deployment and session choices. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function policy(platform: NodeJS.Platform, mode?: 'read-only' | 'workspace-write' | 'danger-full-access') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, mode === undefined ? {} : { mode })
  return ctx.sandboxPolicy
}

describe('platform permission defaults', () => {
  it('keeps Windows read-only without an explicit choice', async () => {
    expect((await policy('win32')).resolve().mode).toBe('read-only')
  })
  it('offers owner guidance only for settled read-only denials under the Windows default', async () => {
    const windows = await policy('win32')
    expect(windows.writeDenialHint('read-only')).toContain('Unattended tasks cannot grant this access.')
    expect(windows.writeDenialHint('workspace-write')).toBeUndefined()
    expect(windows.writeDenialHint('danger-full-access')).toBeUndefined()
    expect((await policy('win32', 'read-only')).writeDenialHint('read-only')).toBeUndefined()
    expect((await policy('linux')).writeDenialHint('read-only')).toBeUndefined()
    expect((await policy('darwin')).writeDenialHint('read-only')).toBeUndefined()
  })
  it('uses a durable workspace authorization only for the Windows default and observes revocation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-default-access-'))
    try {
      vi.stubEnv('PANEDESK_HOME', home)
      const service = await policy('win32')
      expect(service.resolve().mode).toBe('read-only')
      await service.workspaceAccess.authorize(process.cwd(), 'settings-preauthorization')
      expect(service.resolve().mode).toBe('workspace-write')
      expect(service.resolve({ mode: 'read-only' }).mode).toBe('read-only')
      await service.workspaceAccess.revoke(process.cwd(), () => {})
      expect(service.resolve().mode).toBe('read-only')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  it.each(['linux', 'darwin'] as const)('keeps %s workspace-writable without an explicit choice', async (platform) => {
    expect((await policy(platform)).resolve().mode).toBe('workspace-write')
  })
  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('honors explicit Windows mode %s', async (mode) => {
    expect((await policy('win32', mode)).resolve().mode).toBe(mode)
  })
})
