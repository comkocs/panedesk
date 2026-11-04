/** Host coverage completes native profiles without masking backend limitations. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import { SessionId } from '@panedesk/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalSandboxProvider } from '../src/index.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

async function fixture(covered: boolean, linked = false) {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-host-coverage-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  mkdirSync(home)
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
  vi.stubEnv('PANEDESK_HOME', home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const input = join(workspace, 'config.yml')
  if (linked) {
    const target = join(root, 'owner.yml')
    writeFileSync(target, 'approved')
    symlinkSync(target, input)
  }
  const integrity = new ProtectedInputIntegrity(workspace, home)
  if (covered) {
    integrity.observe(input)
    await integrity.grantWrite()
  }
  const profile: ProfileContext = {
    name: 'test', dir: home, patchPath: input, cwd: workspace, home,
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
  const nativeInputs = [home, join(home, 'cordis.patch.yml'), join(home, 'windows-workspace-write'),
    ...linked ? [join(root, 'owner.yml')] : []].sort().map(path => ({ path, enforcement: 'native' }))
  return { provider, integrity, input, workspace, nativeInputs, profile }
}

it.each([false, true])('reports full with recorded host coverage for a linked input: %s', async (linked) => {
  const f = await fixture(true, linked)
  const result = await f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  })
  expect(result.enforcement).toBe('full')
  expect(result.protectedInputs).toEqual([
    { path: f.input, enforcement: 'host-fallback', reason: linked ? 'link-name' : 'unrepresentable' },
    ...f.nativeInputs,
  ])
})

it('waits for an in-progress baseline before returning writable sandbox argv', async () => {
  const f = await fixture(false)
  writeFileSync(f.input, 'trusted')
  f.integrity.observe(f.input)
  const capture = f.integrity.grantWrite()
  let settled = false
  const launch = f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  }).finally(() => { settled = true })
  const outcome = launch.then(value => ({ value }), (error: unknown) => ({ error }))
  await Promise.resolve()
  expect(settled).toBe(false)
  await capture
  const result = await outcome
  expect('value' in result).toBe(true)
})

it('rejects writable sandbox startup after capture failure until a new grant succeeds', async () => {
  const f = await fixture(false)
  writeFileSync(f.input, 'trusted')
  f.integrity.observe(f.input)
  const original = fs.openSync
  const read = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === f.input && args[1] === 'r') throw new Error('capture interrupted')
    return original(...args)
  })
  onTestFinished(() => { read.mockRestore() })
  const policy = { mode: 'workspace-write' as const, workspaceRoot: f.workspace, protectedPaths: [f.input] }
  const capture = Promise.resolve().then(() => f.integrity.grantWrite())
  await Promise.resolve()
  const launch = f.provider.confine(['true'], policy)
  await Promise.all([
    expect(capture).rejects.toThrow('capture interrupted'),
    expect(launch).rejects.toThrow('capture interrupted'),
  ])
  await expect(f.provider.confine(['true'], policy)).rejects.toThrow('capture interrupted')
  await expect(f.provider.confine(['true'], policy)).rejects.toThrow('Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline.')
  await expect(f.provider.confine(['true'], policy)).rejects.toThrow('受保护宿主输入捕获失败。请重新显式授权该工作区写入一次，以重新捕获基线。')
  read.mockRestore()
  await f.integrity.grantWrite()
  expect((await f.provider.confine(['true'], policy)).enforcement).toBe('full')
})

it('does not deny a captured workspace because another workspace capture failed', async () => {
  const f = await fixture(true)
  const otherWorkspace = join(f.workspace, '..', 'other-workspace')
  mkdirSync(otherWorkspace)
  const otherInput = join(otherWorkspace, 'config.yml')
  writeFileSync(otherInput, 'other input')
  const other = new ProtectedInputIntegrity(otherWorkspace, f.profile.home)
  other.observe(otherInput)
  f.profile.inputIntegrities = new Map([[otherWorkspace, other]])
  const original = fs.openSync
  const read = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === otherInput && args[1] === 'r') throw new Error('other capture interrupted')
    return original(...args)
  })
  onTestFinished(() => { read.mockRestore() })
  await expect(Promise.resolve().then(() => other.grantWrite())).rejects.toThrow('other capture interrupted')
  const result = await f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  })
  expect(result.enforcement).toBe('full')
})

it('does not return writable argv to a caller cancelled during capture', async () => {
  const f = await fixture(false)
  writeFileSync(f.input, 'trusted')
  f.integrity.observe(f.input)
  const capture = f.integrity.grantWrite()
  const controller = new AbortController()
  const launch = f.provider.confine(['true'], {
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [f.input],
  }, controller.signal)
  controller.abort(new Error('caller cancelled'))
  await expect(launch).rejects.toThrow('caller cancelled')
  await capture
  expect(f.integrity.covers(f.input)).toBe(true)
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
    protectedInputs: [{ path: f.input, enforcement: 'host-fallback', reason: 'unrepresentable' }, ...f.nativeInputs],
  })
})

it('keeps absent inputs outside writable mounts natively protected', async () => {
  const f = await fixture(true)
  const outside = join(f.workspace, '..', 'absent.yml')
  const status = f.provider.inspect({ mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [outside] })
  expect(status).toEqual({ enforcement: 'full', protectedInputs: [
    { path: outside, enforcement: 'native' }, ...f.nativeInputs,
    { path: f.input, enforcement: 'host-fallback', reason: 'unrepresentable' },
  ] })
})

it('does not treat unrelated Windows temporary homes as writable private session directories', async () => {
  const f = await fixture(true)
  const outside = join(f.workspace, '..', 'absent.yml')
  const link = join(f.workspace, '..', 'linked.yml')
  symlinkSync(f.workspace, link, 'dir')
  f.provider.internals = { platform: 'win32', windowsAclRunnerArgs: ['windows-acl-runner'] }
  const status = f.provider.inspect({
    mode: 'workspace-write', workspaceRoot: f.workspace, sessionId: SessionId('external-home'),
    protectedPaths: [outside],
  })
  expect(status.protectedInputs).toContainEqual({ path: outside, enforcement: 'native' })
  expect(status.protectedInputs).toContainEqual({ path: f.input, enforcement: 'host-fallback', reason: 'unrepresentable' })
  expect(() => f.provider.inspect({
    mode: 'workspace-write', workspaceRoot: f.workspace, protectedPaths: [link],
  })).toThrow('Protected host input has no fallback coverage')
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
