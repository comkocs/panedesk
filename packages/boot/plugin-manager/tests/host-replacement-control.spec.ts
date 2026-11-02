/** A separate development host observes writable modules; the model's own host remains protected. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import Hmr from '@panedesk/dsh-hmr'
import Timer from '@panedesk/cordis-plugin-timer'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@panedesk/dsh-agent-loop-testkit'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import { SessionId } from '@panedesk/dsh-session'
import { ToolCallId } from '@panedesk/dsh-llm'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import * as ToolFs from '@panedesk/dsh-tool-fs'

for (const protectedHost of [false, true]) {
  it(`observes module replacement only outside the calling host inputs, protected: ${protectedHost}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-replacement-control-'))
    const writer = new Context()
    let observer: Context | undefined
    onTestFinished(async () => {
      await writer.fiber.dispose(); await observer?.fiber.dispose()
      vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
    })
    const workspace = join(root, 'workspace')
    const plugin = join(workspace, 'plugin.mjs')
    mkdirSync(workspace)
    const before = 'export const revision = "before"; export function apply() {}\n'
    const after = 'export const revision = "after"; export function apply() {}\n'
    writeFileSync(plugin, before)
    const dir = join(root, 'home', 'profiles', 'observer')
    initProfile(dir, [])
    writeFileSync(join(root, 'package.json'), '{"name":"replacement-fixture","dependencies":{}}')
    writeFileSync(join(dir, 'cordis.yml'), JSON.stringify([{ id: 'probe', name: pathToFileURL(plugin).href }]))
    const profile: ProfileContext = { name: 'observer', dir, patchPath: join(dir, 'cordis.patch.yml'), home: join(root, 'home'), cwd: workspace,
      installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    const host = await boot('observer', join(dir, 'cordis.yml'), readProfilePatches('observer', profile), (ctx) => {
      observer = ctx
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    })
    await host.plugin(Timer)
    await host.plugin(Hmr, { root: [dirname(plugin)], ignored: [], debounce: 0, awaitWriteFinish: false })
    const reload = vi.fn()
    host.on('hmr/reload', reload)
    const entry = [...host.loader.entries()].find(row => row.options.id === 'probe')!
    const originalNamespace = entry.moduleNamespace
    const caller = protectedHost ? host : writer
    await mountAgentLoopTestDependencies(caller)
    provideWorkingDirectoryFixture(caller)
    vi.stubEnv('PANEDESK_HOME', join(root, 'writer-home'))
    vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
    await caller.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
    await caller.plugin(SandboxedFileSystem, { cwd: workspace })
    await caller.plugin(ToolFs)
    const harness = await mountAgentLoopTestHarness(caller)
    const agent = await harness.create(SessionId('replacement-writer'), {}, { cwd: workspace })
    agent.session.append('turn/start', { turn: 1 })
    const result = await caller.tools.execute({ name: 'write', arguments: { file_path: plugin, content: after }, agent,
      callId: ToolCallId('replace-module'), signal: new AbortController().signal })
    if (protectedHost) {
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('protected host path')
      expect(readFileSync(plugin, 'utf8')).toBe(before)
      await new Promise(resolve => setTimeout(resolve, 100))
      await host.hmr.runExclusive(async () => {})
      expect(reload).not.toHaveBeenCalled()
      expect(entry.moduleNamespace).toBe(originalNamespace)
    } else {
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      expect(readFileSync(plugin, 'utf8')).toBe(after)
      await expect.poll(() => reload.mock.calls.length).toBe(1)
      expect(entry.moduleNamespace).not.toBe(originalNamespace)
      expect(entry.moduleNamespace).toMatchObject({ revision: 'after' })
    }
  })
}
