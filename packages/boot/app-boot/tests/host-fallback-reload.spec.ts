/** Owner-approved fallback inputs stay effective through real Loader recomposition. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState } from '@panedesk/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { boot, ProtectedInputIntegrity, recomposeProfile } from '../src/index.ts'

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
  integrity.grantWrite()
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
