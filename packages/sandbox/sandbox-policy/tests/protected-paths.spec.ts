/** Protection follows the running composition, not names of unrelated source trees. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import { initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveProtectedPaths } from '../src/protected-paths.ts'
import { assertUnprotectedRoots, protectedWorkspaceBranches } from '@panedesk/dsh-sandbox'

it('protects the effective owner authorization root without a profile service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-record-protection-'))
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', root)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  expect(resolveProtectedPaths(ctx)).toContain(join(root, 'windows-workspace-write'))
})

it.skipIf(process.platform === 'win32')('retains a watched symlink spelling as well as its target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watched-link-'))
  const workspace = join(root, 'workspace')
  const target = join(root, 'owner.yml')
  mkdirSync(workspace)
  writeFileSync(target, 'owner: true\n')
  const alias = join(workspace, 'watched.yml')
  symlinkSync(target, alias)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const profile: ProfileContext = {
    name: 'active', dir: join(root, 'profile'), patchPath: alias, home: join(root, 'home'),
    cwd: workspace, installAnchor: join(root, 'package.json'), startedBundles: [],
    overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  expect(resolveProtectedPaths(ctx)).toContain(target)
  expect(resolveProtectedPaths(ctx)).toContain(alias)
})

it('keeps ledger and session branches outside sandbox write grants under a home workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-write-protection-'))
  const home = join(root, '.panedesk')
  const dir = join(home, 'profiles', 'active')
  mkdirSync(dir, { recursive: true })
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', home)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  ctx.provide('profileContext', {
    name: 'active', dir, patchPath: join(dir, 'cordis.patch.yml'), home,
    cwd: root, installAnchor: join(dir, 'package.json'), startedBundles: [],
    overlays: [], telemetryDisabledEnv: undefined,
  })
  const protectedPaths = resolveProtectedPaths(ctx, root)
  expect(protectedWorkspaceBranches(root, protectedPaths)).toEqual([home])
  for (const name of ['ledger', 'sessions']) {
    expect(() => { assertUnprotectedRoots([join(home, name)], protectedPaths) })
      .toThrow('Cannot grant sandbox writes across protected host path')
  }
})

it('protects actual bundle configuration files outside the profile directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-inputs-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const dir = join(root, 'home', 'profiles', 'active')
  const installation = join(root, 'installation')
  const bundle = join(installation, 'node_modules', 'active-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ dependencies: { 'active-bundle': '*' } }))
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'active-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), '[]\n')
  initProfile(dir, ['active-bundle'])
  const profile: ProfileContext = {
    name: 'active', dir, patchPath: join(dir, 'cordis.patch.yml'), home: join(root, 'home'),
    cwd: root, installAnchor: join(installation, 'package.json'), startedBundles: ['active-bundle'],
    overlays: [], telemetryDisabledEnv: undefined,
  }
  readProfilePatches('test', profile)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('profileContext', profile)
  expect(resolveProtectedPaths(ctx)).toContain(join(bundle, 'cordis.patch.yml'))
  expect(resolveProtectedPaths(ctx)).toContain(join(bundle, 'package.json'))
  expect(resolveProtectedPaths(ctx)).not.toContain(installation)
})

it('protects an absolute loaded plugin without a Loader base URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absolute-host-input-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'plugin.mjs')
  writeFileSync(path, 'export function apply() {}\n')
  ctx.baseUrl = pathToFileURL(root + '/').href
  await ctx.plugin(Loader)
  await ctx.loader.create({ name: path })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) Reflect.set(entry.parent.tree.ctx, 'baseUrl', undefined)
  expect(resolveProtectedPaths(ctx)).toContain(root)
})

it('does not protect a disabled source clone that has never loaded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'disabled-host-input-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  ctx.baseUrl = pathToFileURL(root + '/').href
  await ctx.plugin(Loader)
  await ctx.loader.create({ name: './unrelated-clone/index.mjs', disabled: true })
  await ctx.loader.await()
  expect(resolveProtectedPaths(ctx)).not.toContain(join(root, 'unrelated-clone'))
})
