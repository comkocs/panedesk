/** Landlock-only startup reports session risk without denying the command. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { afterEach, expect, it, vi } from 'vitest'
import * as sessions from '../src/session-sockets.ts'

vi.mock('../src/session-sockets.ts', async original => ({ ...await original<typeof sessions>() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

for (const present of [true, false]) {
  it(`Landlock session warning when host locations exist: ${present}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-warning-'))
    vi.stubEnv('PANEDESK_HOME', home)
    vi.spyOn(sessions, 'hasHostSessionSockets').mockReturnValue(present)
    const ctx = new Context()
    try {
      await ctx.plugin(LocalSandboxProvider)
      const sandbox = ctx.sandbox
      if (!(sandbox instanceof LocalSandboxProvider)) throw new Error('local sandbox missing')
      sandbox.internals = { chain: ['landlock'], landlockLauncher: '/test/landlock-run' }
      const warn = vi.spyOn(ctx.logger, 'warn')
      const result = await sandbox.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: home })
      expect(result.argv[0]).toBe('/test/landlock-run')
      expect(result.argv.slice(-2)).toEqual(['--', '/bin/true'])
      if (present) {
        expect(warn).toHaveBeenCalledExactlyOnceWith('Landlock-only sandbox processes may connect to host tmux, screen or session bus sockets and run host commands; use separate user accounts. / 仅用 Landlock 的沙箱仍可能连接宿主 tmux、screen 或会话总线并执行宿主命令；建议分用户运行。')
      } else expect(warn).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
