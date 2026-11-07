/** An independent complete checkout is writable without changing the live host profile. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import Sandbox from '@panedesk/dsh-sandbox-local'
import Subprocess from '@panedesk/dsh-subprocess-local'
import Bash from '@panedesk/dsh-bash-sandbox'
import NodeRuntime from '@panedesk/dsh-ptc-runtime-node'

const checkout = process.env.DSH_TEST_SOURCE_CLONE
for (const implicit of [false, true]) for (const entry of ['write', 'bash', 'run_code'] as const) {
  it.skipIf(checkout === undefined)(`writes a complete independent source clone through ${entry}, implicit Windows: ${implicit}`, async () => {
    const workspace = checkout!
    expect(execFileSync('git', ['-C', workspace, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim()).toBe('false')
    expect(execFileSync('git', ['-C', workspace, 'ls-files'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').length).toBeGreaterThan(10000)
    const root = mkdtempSync(join(tmpdir(), 'clone-host-'))
    let ctx: Context | undefined
    const target = join(workspace, `independent-${entry}-${String(implicit)}.txt`)
    onTestFinished(async () => {
      await ctx?.fiber.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs()
      rmSync(target, { force: true }); rmSync(root, { recursive: true, force: true })
    })
    const dir = join(root, 'profiles', 'test')
    initProfile(dir, [])
    writeFileSync(join(root, 'package.json'), '{"name":"installation","dependencies":{}}')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home: root, cwd: workspace,
      installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    const host = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (current) => {
      ctx = current
      current.provide('profileContext', profile)
      current.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    })
    await host.plugin(Timer)
    await host.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await mountAgentLoopTestDependencies(host, { tools: { mode: entry === 'run_code' ? 'ptc' : 'native' } })
    provideWorkingDirectoryFixture(host)
    vi.stubEnv('PANEDESK_HOME', root)
    vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try { await host.plugin(SandboxPolicy, { workspaceRoot: workspace, ...implicit ? {} : { mode: 'workspace-write' } }) }
    finally { platform.mockRestore() }
    await host.plugin(ApprovalService, { policy: 'ask' })
    await host.plugin(SandboxedFileSystem, { cwd: workspace })
    host.loader.builtins.fileTools = ToolFs
    await host.loader.create({ name: 'cordis:fileTools' })
    await host.loader.await()
    const harness = await mountAgentLoopTestHarness(host)
    const agent = await harness.create(SessionId('source-clone-write'), {}, { cwd: workspace })
    agent.session.append('turn/start', { turn: 1 })
    const answer = vi.fn(async () => 'allowed-once' as const)
    await ownerAnswer(host, answer)
    expect(host.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
    expect(answer).not.toHaveBeenCalled()
    const recompose = vi.spyOn(host.hmr, 'reconcileProfile')
    const rows = [...host.loader.entries()].map(row => row.options)
    if (entry === 'write') {
      const result = await host.tools.execute({ name: 'write', arguments: { file_path: target, content: 'independent' }, agent,
        callId: ToolCallId('independent-write'), signal: new AbortController().signal })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    } else {
      await host.plugin(Subprocess)
      await host.plugin(Sandbox)
      if (entry === 'bash') {
        await host.plugin(Bash, { graceMs: 200 })
        const command = `printf independent > '${target.replaceAll("'", "'\\''")}'`
        const result = await (await host.shell.execute(host.shell.resolve({ command, workdir: workspace }))).result()
        expect(result.exitCode).toBe(0)
      } else {
        await host.plugin(NodeRuntime, { timeoutMs: 10000 })
        const code = `const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(target)}, 'independent');`
        const result = await host.tools.execute({ name: 'run_code', arguments: { code, description: 'Write an independent checkout' }, agent,
          callId: ToolCallId('independent-write'), signal: new AbortController().signal })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      }
    }
    expect(readFileSync(target, 'utf8')).toBe('independent')
    await new Promise(resolve => setTimeout(resolve, 100))
    await host.hmr.runExclusive(async () => {})
    expect(recompose).not.toHaveBeenCalled()
    expect([...host.loader.entries()].map(row => row.options)).toEqual(rows)
  })
}
