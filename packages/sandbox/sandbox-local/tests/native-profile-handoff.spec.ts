/** Native profile hand-offs do not grant writable ancestors of live host inputs. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { spawnSubprocess } from '@panedesk/dsh-subprocess-local/src/spawn.ts'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'

it.each(['linux', 'darwin'] as const)('%s production hand-off creates a new session without inherited terminal input', async (platform) => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-session-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  vi.stubEnv('PANEDESK_HOME', join(root, 'owner'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform, probeBwrap: () => false, probeLandlock: () => 'full', landlockLauncher: '/synthetic/landlock-run' }
  const confined = await provider.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })
  expect(confined.argv[0]).toBe(platform === 'linux' ? '/synthetic/landlock-run' : 'sandbox-exec')
  expect(confined.argv.slice(-2)).toEqual(['--', 'true'])
  const reachedSpawn = new Error('synthetic spawn boundary')
  const spawn = vi.fn(() => { throw reachedSpawn })
  expect(() => spawnSubprocess({
    argv: confined.argv, cwd: workspace,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100,
  }, { platform, spawn })).toThrow(reachedSpawn)
  expect(spawn).toHaveBeenCalledWith(confined.argv[0], confined.argv.slice(1), expect.objectContaining({
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  }))
})

it('omits shared writable temp ancestors from the actual Seatbelt hand-off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seatbelt-live-input-'))
  const workspace = join(root, 'workspace')
  const input = join(root, 'host.mjs')
  mkdirSync(workspace); writeFileSync(input, 'export {}')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'darwin' }
  const handed = await provider.confine(['node', input], { mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [input] })
  expect(handed.argv[0]).toBe('sandbox-exec')
  expect(handed.argv[2]).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`)
  expect(handed.argv[2]).not.toContain(`(subpath ${JSON.stringify(tmpdir())})`)
})
