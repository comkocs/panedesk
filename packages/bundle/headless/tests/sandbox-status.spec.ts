/** Sandbox diagnostics do not create Agents, read stdin, or call a model. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import SessionProjections from '@panedesk/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

it.each([
  ['en', true], ['zh', true], ['en', false], ['zh', false],
] as const)('reports every host fallback in %s with JSON %s without a model request', async (locale, json) => {
  const root = mkdtempSync(join(tmpdir(), 'headless-sandbox-status-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  vi.stubEnv('PANEDESK_HOME', home)
  const input = join(workspace, 'missing.yml')
  mkdirSync(workspace)
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(input)
  await integrity.grantWrite()
  const profile: ProfileContext = {
    name: 'test', dir: home, patchPath: input, cwd: workspace, home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined, inputIntegrity: integrity, protectedInputPaths: () => [input],
  }
  const ctx = new Context()
  ctx.provide('profileContext', profile)
  const original = { ...internals }
  onTestFinished(async () => {
    Object.assign(internals, original)
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider)
  if (!(ctx.sandbox instanceof LocalSandboxProvider)) throw new Error('Local sandbox missing')
  ctx.sandbox.internals = { platform: 'linux', probeBwrap: () => true }
  let stdout = ''
  internals.stdout = { write: (chunk: string) => { stdout += chunk; return true } }
  internals.stderr = { write: () => true }
  internals.readStdin = async () => { throw new Error('Diagnostic must not read stdin') }
  const exited = Promise.withResolvers<number>()
  ctx.provide('appExit', (code: number) => { exited.resolve(code) })
  apply(ctx, { sandboxStatus: locale, json })
  expect(await exited.promise).toBe(0)
  if (!json) {
    expect(stdout).toBe(`full: ${locale === 'zh' ? '1 项由宿主兜底' : '1 input protected by host fallback'}\n${[
      `native\t${home}`, `native\t${join(home, 'cordis.patch.yml')}`,
      `native\t${join(home, 'windows-workspace-write')}`, `host-fallback\t${input}`,
    ].join('\n')}\n`)
    return
  }
  expect(JSON.parse(stdout)).toMatchObject({
    type: 'sandbox-status', enforcement: 'full',
    hostFallbackCount: 1,
    message: locale === 'zh' ? '1 项由宿主兜底' : '1 input protected by host fallback',
    protectedInputs: [
      { path: home, enforcement: 'native' },
      { path: join(home, 'cordis.patch.yml'), enforcement: 'native' },
      { path: join(home, 'windows-workspace-write'), enforcement: 'native' },
      { path: input, enforcement: 'host-fallback', reason: 'unrepresentable' },
    ],
  })
})
