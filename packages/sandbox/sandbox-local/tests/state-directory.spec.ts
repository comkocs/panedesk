/** State exclusions reach the native profile without freezing unrelated workspace children. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalSandboxProvider } from '../src/index.ts'

it('allows Windows read-only startup but refuses a write grant containing owner material', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'windows-owner-profile-'))
  const home = join(workspace, 'home')
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', home)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(workspace, { recursive: true, force: true })
  })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'runner.js'] }
  const read = await provider.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })
  expect(read.argv.slice(-6)).toEqual(['--mode', 'read-only', '--unreadable-path', join(home, 'private'), '--', 'true'])
  await expect(provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace })).rejects.toThrow(
    'The workspace contains an owner private directory; choose a workspace outside that directory tree. / 工作区包含所有者私密目录，请选择不含该目录树的工作区。',
  )
})

it.each(['linux', 'darwin'] as const)('hands a first-child state exclusion to confine on %s before creation can race', async (platform) => {
  const workspace = mkdtempSync(join(tmpdir(), 'state-profile-'))
  const home = join(workspace, '.panedesk', 'nested')
  const excluded = join(workspace, '.panedesk')
  const ctx = new Context()
  const ownerHome = mkdtempSync(join(tmpdir(), 'state-profile-owner-'))
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
  ctx.provide('profileContext', {
    name: 'state-profile', home, cwd: workspace, dir: home, patchPath: join(home, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  vi.stubEnv('PANEDESK_HOME', ownerHome)
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(ownerHome, { recursive: true, force: true })
  })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform, probeBwrap: () => true }
  const handed = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace })
  if (platform === 'linux') {
    expect(handed.argv.join('\n')).toContain(['--bind', workspace, workspace].join('\n'))
    expect(handed.argv.join('\n')).toContain(['--ro-bind', excluded, excluded].join('\n'))
    expect(handed.argv.join('\n')).not.toContain(['--ro-bind', workspace, workspace].join('\n'))
  } else {
    expect(handed.argv[2]).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`)
    expect(handed.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(excluded)}))`)
  }
  expect(handed.protectedInputs).toContainEqual({ path: excluded, enforcement: 'native' })
  mkdirSync(join(workspace, 'new-project'))
  writeFileSync(join(workspace, 'new-project', 'ordinary.txt'), 'owner fixture')
})
