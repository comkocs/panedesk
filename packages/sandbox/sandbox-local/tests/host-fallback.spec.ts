/** Host coverage completes native profiles without masking backend limitations. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { LocalSandboxProvider } from '../src/index.ts'

async function fixture(covered: boolean, linked = false) {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-host-coverage-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const input = join(workspace, 'config.yml')
  if (linked) {
    const target = join(root, 'owner.yml')
    writeFileSync(target, 'approved')
    symlinkSync(target, input)
  }
  const integrity = new ProtectedInputIntegrity(workspace, home)
  if (covered) {
    integrity.observe(input)
    integrity.grantWrite()
  }
  const profile: ProfileContext = {
    name: 'test', dir: workspace, patchPath: input, cwd: workspace, home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined, inputIntegrity: integrity,
  }
  const ctx = new Context()
  ctx.provide('profileContext', profile)
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local sandbox missing')
  provider.internals = { platform: 'linux', probeBwrap: () => true }
  return { provider, integrity, input, workspace }
}

it.each([false, true])('reports full with recorded host coverage for a linked input: %s', async (linked) => {
  const f = await fixture(true, linked)
  const result = await f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  })
  expect(result.enforcement).toBe('full')
  expect(result.protectedInputs).toEqual([{
    path: f.input, enforcement: 'host-fallback', reason: linked ? 'link-name' : 'unrepresentable',
  }])
})

it('refuses an uncovered input before returning executable argv', async () => {
  const f = await fixture(false)
  await expect(f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  })).rejects.toThrow('Protected host input has no fallback coverage')
  expect(f.integrity.covers(f.input)).toBe(false)
})

it('inspects coverage without returning executable argv or granting workspace access', async () => {
  const f = await fixture(true)
  expect(f.provider.inspect({ mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input] })).toEqual({
    enforcement: 'full',
    protectedInputs: [{ path: f.input, enforcement: 'host-fallback', reason: 'unrepresentable' }],
  })
})

it('keeps absent inputs outside writable mounts natively protected', async () => {
  const f = await fixture(false)
  const outside = join(f.workspace, '..', 'absent.yml')
  const status = f.provider.inspect({ mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [outside] })
  expect(status).toEqual({ enforcement: 'full', protectedInputs: [{ path: outside, enforcement: 'native' }] })
})

it('refuses an uncovered absent input in a writable temporary root outside the workspace', async () => {
  const f = await fixture(false)
  const outside = join(f.workspace, '..', 'absent.yml')
  f.provider.internals = { platform: 'win32', windowsAclRunnerArgs: ['windows-acl-runner'] }
  await expect(f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [outside],
  })).rejects.toThrow('Protected host input has no fallback coverage')
})

it('refuses an uncovered external cyclic input with a coverage diagnostic', async () => {
  const f = await fixture(false)
  const outside = join(f.workspace, '..', 'cyclic.yml')
  symlinkSync(outside, outside)
  expect(() => f.provider.inspect({ mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [outside] }))
    .toThrow('Protected host input has no fallback coverage')
})

it('rejects a Windows workspace containing the temporary root before reporting readiness', async () => {
  const f = await fixture(false)
  f.provider.internals = { platform: 'win32' }
  expect(() => f.provider.inspect({ mode: 'workspace-write', workspaceRoot: tmpdir() }))
    .toThrow(/temp/i)
})

it('preserves partial enforcement reported by an older Landlock backend', async () => {
  const f = await fixture(true)
  f.provider.internals = { platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'partial' }
  const result = await f.provider.confine(['true'], {
    mode: 'read-only', workspaceRoot: f.workspace, protectedPaths: [f.input],
  })
  expect(result.enforcement).toBe('partial')
})
