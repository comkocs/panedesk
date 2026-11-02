/** File tools retain host inputs after owner consent through a live profile Loader. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import Hmr from '@panedesk/dsh-hmr'
import Timer from '@panedesk/cordis-plugin-timer'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@panedesk/dsh-agent-loop-testkit'
import { ownerAnswer } from '../../../fs/tool-fs/tests/owner-answer.ts'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import ApprovalService from '@panedesk/dsh-user-approval'
import { SessionId } from '@panedesk/dsh-session'
import { ToolCallId } from '@panedesk/dsh-llm'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import * as StrReplaceEditor from '@panedesk/dsh-tool-str-replace-editor'
import { ClientModuleRegistry } from '@panedesk/dsh-client-modules'
import * as ClientHmr from '@panedesk/dsh-client-hmr'
import WebServer from '@panedesk/dsh-host-webserver'

const locations = [
  'home patch', 'authorization records', 'profile patch', 'bundle input',
  'command overlay', 'loaded plugin', 'active config', 'client artifact',
] as const

for (const implicit of [false, true]) for (const tool of ['write', 'edit', 'str_replace_editor']) {
  for (const location of locations) {
    it(`denies ${tool} at ${location} after owner consent, implicit Windows: ${implicit}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'host-input-matrix-'))
      let ctx: Context | undefined
      onTestFinished(async () => {
        await ctx?.fiber.dispose(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
      })
      const home = join(root, 'home')
      const workspace = join(root, 'workspace')
      const dir = join(home, 'profiles', 'test')
      mkdirSync(workspace, { recursive: true })
      initProfile(dir, [])
      writeFileSync(join(root, 'package.json'), '{"name":"installation","dependencies":{}}')
      const plugin = join(root, 'loaded', 'plugin.mjs')
      mkdirSync(dirname(plugin))
      writeFileSync(plugin, 'export function apply() {}\n')
      const artifact = join(dirname(plugin), 'lib', 'client.js')
      mkdirSync(dirname(artifact))
      writeFileSync(artifact, 'module.exports = {}\n')
      writeFileSync(join(dirname(plugin), 'package.json'), JSON.stringify({
        name: 'live-client-probe', type: 'module', exports: { '.': './plugin.mjs', './client': './lib/client.js', './package.json': './package.json' },
        dsh: { client: { platform: 'web' } },
      }))
      writeFileSync(join(dir, 'cordis.yml'), JSON.stringify([{ id: 'probe', name: pathToFileURL(plugin).href }]))
      const bundle = join(root, 'bundle', 'cordis.patch.yml')
      const overlay = join(root, 'overlay', 'cordis.patch.yml')
      const watched = join(root, 'config', 'runtime.yml')
      for (const filename of [bundle, overlay, watched]) {
        mkdirSync(dirname(filename), { recursive: true })
        writeFileSync(filename, '[]\n')
      }
      const profile: ProfileContext = {
        name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: workspace,
        installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [],
        bundleInputPaths: [bundle], overlayPaths: [overlay], telemetryDisabledEnv: undefined,
      }
      const host = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (current) => {
        ctx = current
        current.provide('profileContext', profile)
        current.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      })
      await host.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      Object.assign(host.loader.builtins, { clientModules: ClientModuleRegistry, clientHmr: ClientHmr })
      await host.loader.create({ name: 'cordis:clientModules' })
      await host.loader.create({ name: 'cordis:clientHmr', config: { pollIntervalMs: 10 } })
      await host.loader.await()
      const rebuilt = vi.fn()
      host.clientModules.onRebuilt(rebuilt)
      const graph = host.clientModules.graph()
      expect(graph.entries.some(entry => entry.id === 'live-client-probe')).toBe(true)
      await host.plugin(Timer)
      await host.plugin(Hmr, { root: [dirname(plugin)], ignored: [], debounce: 0, awaitWriteFinish: false })
      const moduleChanged = vi.fn()
      host.on('hmr/change', moduleChanged)
      const refreshed = vi.fn(async () => {})
      await host.hmr.watchConfig(watched, refreshed)
      await host.hmr.runExclusive(async () => {})
      refreshed.mockClear()
      await mountAgentLoopTestDependencies(host)
      provideWorkingDirectoryFixture(host)
      vi.stubEnv('PANEDESK_HOME', home)
      vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      try { await host.plugin(SandboxPolicy, { workspaceRoot: workspace, ...implicit ? {} : { mode: 'workspace-write' } }) }
      finally { platform.mockRestore() }
      await host.plugin(ApprovalService, { policy: 'ask' })
      await host.plugin(SandboxedFileSystem, { cwd: workspace })
      Object.assign(host.loader.builtins, { fileTools: ToolFs, editorTool: StrReplaceEditor })
      await host.loader.create({ name: 'cordis:fileTools' })
      await host.loader.create({ name: 'cordis:editorTool' })
      await host.loader.await()
      const harness = await mountAgentLoopTestHarness(host)
      const agent = await harness.create(SessionId('live-input-matrix'), {}, { cwd: workspace })
      agent.session.append('turn/start', { turn: 1 })
      const answer = vi.fn(async () => 'allowed-once' as const)
      await ownerAnswer(host, answer)
      if (implicit) {
        expect((await host.sandboxPolicy.requestWrite({ agent, toolName: 'write' })).mode).toBe('workspace-write')
        expect(answer).toHaveBeenCalledOnce()
      }
      const targets = {
        'home patch': join(home, 'cordis.patch.yml'),
        'authorization records': join(home, 'windows-workspace-write', 'model.json'),
        'profile patch': profile.patchPath, 'bundle input': bundle, 'command overlay': overlay,
        'loaded plugin': plugin, 'active config': watched, 'client artifact': artifact,
      }
      const target = targets[location]
      mkdirSync(dirname(target), { recursive: true })
      const original = location === 'loaded plugin' || location === 'client artifact' ? readFileSync(target, 'utf8') : '[]\n'
      if (location !== 'loaded plugin' && location !== 'client artifact') writeFileSync(target, original)
      await new Promise(resolve => setTimeout(resolve, 75))
      await host.hmr.runExclusive(async () => {})
      refreshed.mockClear()
      const rows = [...host.loader.entries()].map(entry => ({
        id: entry.options.id, name: entry.options.name, module: entry.moduleNamespace,
      }))
      const recompose = vi.spyOn(host.hmr, 'reconcileProfile')
      const payload = location === 'loaded plugin' ? 'export function apply() { throw new Error("model installed") }\n' : '[{"id":"probe","disabled":true}]\n'
      const args = tool === 'write' ? { file_path: target, content: payload }
        : tool === 'edit' ? { file_path: target, old_string: original, new_string: payload }
          : { command: 'str_replace', path: target, old_str: original, new_str: payload }
      const result = await host.tools.execute({ name: tool, arguments: args, agent,
        callId: ToolCallId('live-input-write'), signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      expect(result.content.some(part => part.type === 'text' && part.text.includes('protected host path'))).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe(original)
      await new Promise(resolve => setTimeout(resolve, 100))
      await host.hmr.runExclusive(async () => {})
      expect(refreshed).not.toHaveBeenCalled()
      expect(moduleChanged).not.toHaveBeenCalled()
      expect(recompose).not.toHaveBeenCalled()
      expect(rebuilt).not.toHaveBeenCalled()
      expect(host.clientModules.graph()).toEqual(graph)
      expect([...host.loader.entries()].map(entry => ({
        id: entry.options.id, name: entry.options.name, module: entry.moduleNamespace,
      }))).toEqual(rows)
    })
  }
}
