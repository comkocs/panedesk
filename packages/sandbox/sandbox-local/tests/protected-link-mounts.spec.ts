/** Linked host inputs use real mount destinations without disabling workspace commands. */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { coveredContext } from './host-coverage-fixture.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

function mountDestinations(argv: readonly string[]): { kind: string; path: string }[] {
  const mounts: { kind: string; path: string }[] = []
  for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
    const kind = argv[i]!
    if (kind === '--bind' || kind === '--ro-bind') {
      mounts.push({ kind, path: argv[i + 2]! }); i += 2
    } else if (['--tmpfs', '--dev', '--proc', '--remount-ro'].includes(kind)) {
      mounts.push({ kind, path: argv[++i]! })
    }
  }
  return mounts
}

it.each(['dangling link', 'cyclic link', 'non-directory ancestor'])('marks every unrepresentable input for host validation: %s', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'protected-unrepresentable-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const input = join(root, 'input')
  const path = kind === 'non-directory ancestor' ? join(input, 'config.yml') : input
  const ctx = coveredContext(root, path)
  const { home } = ctx.profileContext
  vi.stubEnv('PANEDESK_HOME', home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  if (kind === 'dangling link') symlinkSync(join(root, 'absent'), input)
  else if (kind === 'cyclic link') symlinkSync(input, input)
  else writeFileSync(input, 'owner')
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'linux', probeBwrap: () => true }
  const handed = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: root, protectedPaths: [path] })
  expect(handed).toHaveProperty('protectedInputs', [
    { path, enforcement: 'host-fallback', reason: 'unrepresentable' },
    ...[home, join(home, 'cordis.patch.yml'), join(home, 'windows-workspace-write')]
      .sort().map(input => ({ path: input, enforcement: 'native' })),
  ])
  const mounts = mountDestinations(handed.argv)
  expect(mounts).toContainEqual({ kind: '--bind', path: root })
  expect(mounts.some(mount => mount.path === path)).toBe(false)
})

it('does not create mounts beneath an already protected directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'protected-covered-input-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile')
  mkdirSync(profile)
  const missing = join(profile, 'missing', 'config.yml')
  const argv = ['bwrap', ...bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: root, protectedPaths: [missing, profile] }), '--', 'true']
  expect(mountDestinations(argv).filter(mount => mount.path.startsWith(`${profile}/`))).toEqual([])
  expect(mountDestinations(argv)).toContainEqual({ kind: '--ro-bind', path: profile })
})

const layouts = [
  ['pnpm package link', 'packages/boot/plugin-manager/node_modules/@panedesk/dsh-host-plugin-inventory'],
  ['profile dependency link', '.panedesk/profiles/headless/node_modules/@panedesk/dsh-agent-default-model'],
  ['linked ancestor', 'linked-node_modules/@panedesk/dsh-agent-default-model'],
] as const

it.each(layouts)('mounts the canonical target of a %s read-only', async (_layout, spelling) => {
  const root = mkdtempSync(join(tmpdir(), 'protected-link-mounts-'))
  const workspace = join(root, 'workspace')
  const target = join(workspace, 'store', 'package')
  const alias = join(workspace, spelling)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'index.js'), 'export const owner = true\n')
  if (_layout === 'linked ancestor') {
    const modules = join(workspace, 'real-node_modules')
    mkdirSync(join(modules, '@panedesk'), { recursive: true })
    symlinkSync(modules, join(workspace, 'linked-node_modules'), 'dir')
  } else mkdirSync(dirname(alias), { recursive: true })
  symlinkSync(target, alias, 'dir')
  const ctx = coveredContext(workspace, alias)
  vi.stubEnv('PANEDESK_HOME', ctx.profileContext.home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'linux', probeBwrap: () => true }
  const handed = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [alias] })
  const mounts = mountDestinations(handed.argv)
  if (process.env.TEST_CAPTURE_NATIVE_PROFILES === '1') console.info(JSON.stringify({ layout: _layout, argv: handed.argv }))
  for (const mount of mounts) {
    for (let path = mount.path; path !== parse(path).root; path = dirname(path)) {
      expect(lstatSync(path).isSymbolicLink(), `symlink mount destination: ${mount.path}`).toBe(false)
    }
  }
  expect(mounts).toContainEqual({ kind: '--ro-bind', path: target })
  expect(mounts).toContainEqual({ kind: '--bind', path: workspace })
  expect(mounts.some(mount => mount.path === alias)).toBe(false)
  expect(mounts.some(mount => mount.kind === '--ro-bind' && mount.path === workspace)).toBe(false)
})

it('leaves external linked targets under the read-only root without an alias mount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'protected-external-link-'))
  const workspace = join(root, 'workspace')
  const target = join(root, 'owner.yml')
  const alias = join(workspace, 'config.yml')
  mkdirSync(workspace)
  writeFileSync(target, 'owner')
  symlinkSync(target, alias)
  const ctx = coveredContext(workspace, alias)
  vi.stubEnv('PANEDESK_HOME', ctx.profileContext.home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'linux', probeBwrap: () => true }
  const handed = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [alias] })
  expect(mountDestinations(handed.argv)).toEqual([
    { kind: '--ro-bind', path: '/' }, { kind: '--dev', path: '/dev' }, { kind: '--proc', path: '/proc' },
    { kind: '--bind', path: workspace },
    { kind: '--tmpfs', path: join(ctx.profileContext.home, 'private') },
    { kind: '--remount-ro', path: join(ctx.profileContext.home, 'private') },
  ])
})
