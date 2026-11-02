/** Protection follows the running composition, not names of unrelated source trees. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import { initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { resolveProtectedPaths } from '../src/protected-paths.ts'

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
