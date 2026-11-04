/** Owner-approved fallback inputs stay effective through real Loader recomposition. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { saveImageFile } from '@panedesk/dsh-attachment-local/src/store.ts'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { boot, ProtectedInputIntegrity, recomposeProfile } from '../src/index.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

it('reloads after saving an image tightens an existing home but refuses widened ancestor write access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'attachment-input-reload-'))
  const home = join(root, 'home')
  const profile = join(home, 'profile')
  mkdirSync(profile, { recursive: true })
  chmodSync(home, 0o755)
  const manifest = join(profile, 'package.json')
  writeFileSync(manifest, '{}\n')
  const config = join(profile, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const owner = `${root}-owner`
  const integrity = new ProtectedInputIntegrity(root, owner)
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(owner, { recursive: true, force: true })
  })
  let ancestorMode = 0o755n
  if (process.platform === 'win32') {
    const original = fs.lstatSync
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = original(...args)
      // Windows chmod does not expose POSIX group/other bits; supply those bits for this comparison.
      if (args[0] === home && stat !== undefined && typeof stat.mode === 'bigint') {
        stat.mode = (stat.mode & ~0o777n) | ancestorMode
      }
      return stat
    })
    onTestFinished(() => { spy.mockRestore() })
  }
  integrity.observe(manifest)
  await integrity.grantWrite()
  const requestInputReview = vi.fn()
  const ctx = await boot('attachment-reload-test', config, [], (host) => {
    host.provide('profileContext', {
      name: 'test', home, cwd: root, dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
      installAnchor: manifest, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
      inputIntegrity: integrity, requestInputReview,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
  await saveImageFile(join(home, 'attachments', 'v1'), { data: image, mediaType: 'image/png' }, {
    maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048,
    maxImagePixels: 16, maxImageDimension: 2000, mediaTypes: ['image/png'],
  }, { maxPixels: 2048 * 2048, maxDimension: 8192, maxBytes: 1024 * 1024 })
  if (process.platform !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700)
  ancestorMode = 0o700n
  await expect(recomposeProfile(ctx, [], 'attachment-reload-test')).resolves.toBeDefined()
  expect(requestInputReview).not.toHaveBeenCalled()
  ancestorMode = 0o777n
  chmodSync(home, 0o777)
  await expect(recomposeProfile(ctx, [], 'attachment-reload-test')).rejects.toThrow('requires owner confirmation')
  expect(requestInputReview).toHaveBeenCalledOnce()
})

it.each(['create-missing', 'replace-link', 'link-to-directory', 'link-to-file', 'recreate-link'] as const)('retains the running Loader generation after %s without owner approval', async (mutation) => {
  const root = mkdtempSync(join(tmpdir(), 'host-fallback-reload-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const patchPath = join(workspace, 'cordis.patch.yml')
  const approved = join(root, 'approved.yml')
  const replacement = join(root, 'replacement.yml')
  writeFileSync(approved, '[]\n')
  writeFileSync(replacement, '- id: retained\n  disabled: true\n')
  if (mutation !== 'create-missing') symlinkSync(approved, patchPath)
  writeFileSync(join(workspace, 'cordis.yml'), '[]\n')
  writeFileSync(join(workspace, 'probe.mjs'), 'export function apply() {}\n')
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(patchPath)
  await integrity.grantWrite()
  const ctx = await boot('fallback-test', join(workspace, 'cordis.yml'), [
    { insert: [{ id: 'retained', name: './probe.mjs' }] },
  ], (host) => {
    host.provide('profileContext', {
      name: 'test', home, cwd: workspace, dir: workspace, patchPath,
      installAnchor: join(workspace, 'package.json'), startedBundles: [], overlays: [],
      telemetryDisabledEnv: undefined, inputIntegrity: integrity,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  if (!(ctx.sandbox instanceof LocalSandboxProvider)) throw new Error('Local sandbox missing')
  ctx.sandbox.internals = { platform: 'linux', probeBwrap: () => true }
  const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace, protectedPaths: [patchPath] }
  expect((await ctx.sandbox.confine(['true'], policy)).enforcement).toBe('full')
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'retained')
  const fiber = entry?.fiber
  expect(fiber?.state).toBe(FiberState.ACTIVE)
  if (mutation !== 'create-missing') unlinkSync(patchPath)
  if (mutation === 'link-to-directory') mkdirSync(patchPath)
  else if (mutation === 'replace-link' || mutation === 'recreate-link') {
    if (mutation === 'recreate-link') {
      writeFileSync(patchPath, '[]\n')
      unlinkSync(patchPath)
    }
    symlinkSync(replacement, patchPath)
  } else writeFileSync(patchPath, '- id: retained\n  disabled: true\n')
  await expect(recomposeProfile(ctx, [], 'fallback-test')).rejects.toThrow('requires owner confirmation')
  expect(entry?.fiber).toBe(fiber)
  expect(fiber?.state).toBe(FiberState.ACTIVE)
  expect(entry?.disabled).toBe(false)
  const restarted = new ProtectedInputIntegrity(workspace, home)
  expect(restarted.readTrusted(patchPath)?.toString()).toBe(mutation === 'create-missing' ? undefined : '[]\n')
})
