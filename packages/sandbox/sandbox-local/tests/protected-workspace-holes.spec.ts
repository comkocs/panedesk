/** Writable workspaces retain protected host inputs in native profiles. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { coveredContext } from './host-coverage-fixture.ts'

it.each(['linux', 'darwin'])('keeps ordinary workspace writes while protecting nested inputs on %s', async (platform) => {
  const root = mkdtempSync(join(tmpdir(), 'protected-workspace-'))
  const workspace = join(root, 'project')
  const parent = join(workspace, '.panedesk')
  const input = join(parent, 'cordis.patch.yml')
  mkdirSync(parent, { recursive: true })
  writeFileSync(input, 'plugins: []\n')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform, probeBwrap: () => true }
  const handed = await provider.confine(['node', '-e', ''], {
    mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [input],
  })
  if (platform === 'linux') {
    expect(handed.argv).toContain('bwrap')
    const writable = handed.argv.indexOf('--bind')
    expect(handed.argv.slice(writable, writable + 3)).toEqual(['--bind', workspace, workspace])
    expect(handed.argv.join('\n')).toContain(['--bind', parent, parent].join('\n'))
    expect(handed.argv.join('\n')).toContain(['--ro-bind', input, input].join('\n'))
  } else {
    expect(handed.argv[0]).toBe('sandbox-exec')
    expect(handed.argv[2]).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`)
    expect(handed.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(input)}))`)
    expect(handed.argv[2]).toContain(`(deny file-write-unlink (literal ${JSON.stringify(parent)}))`)
  }
})

it.each(['linux', 'darwin'])('protects a linked input target with executable platform parameters on %s', async (platform) => {
  const root = mkdtempSync(join(tmpdir(), 'protected-link-'))
  const workspace = join(root, 'project')
  const target = join(root, 'owner.yml')
  const alias = join(workspace, 'watched.yml')
  mkdirSync(workspace)
  writeFileSync(target, 'plugins: []\n')
  symlinkSync(target, alias)
  const ctx = await coveredContext(workspace, alias)
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform, probeBwrap: () => true }
  const handed = await provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [alias, target],
  })
  if (platform === 'linux') {
    expect(handed.argv.slice(1, 4)).toEqual(['--ro-bind', '/', '/'])
    expect(handed.argv).not.toContain(alias)
    expect(handed.argv).not.toContain(target)
    expect(handed.argv.join('\n')).toContain(['--bind', workspace, workspace].join('\n'))
  } else {
    expect(handed.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(alias)}))`)
    expect(handed.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(target)}))`)
  }
})

it.each(['cordis.patch.yml', 'missing/ancestor/cordis.patch.yml'])('hands an absent input to host validation without creating mount points: %s', async (name) => {
  const root = mkdtempSync(join(tmpdir(), 'protected-absent-'))
  const input = join(root, name)
  const ctx = await coveredContext(root, input)
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Profile context missing')
  vi.stubEnv('PANEDESK_HOME', profile.home)
  onTestFinished(async () => { vi.unstubAllEnvs(); await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'linux', probeBwrap: () => true }
  const handed = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: root, protectedPaths: [input] })
  expect(handed.argv).not.toContain(input)
  expect(handed.enforcement).toBe('full')
  expect(handed).toHaveProperty('protectedInputs', [
    { path: input, enforcement: 'host-fallback', reason: 'unrepresentable' },
    ...[profile.home, join(profile.home, 'cordis.patch.yml'), join(profile.home, 'windows-workspace-write')]
      .sort().map(path => ({ path, enforcement: 'native' })),
  ])
  expect(handed.argv.join('\n')).not.toContain(['--ro-bind', root, root].join('\n'))
})
