/** First-write consent uses the real tool, policy, approval, record, and filesystem path. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { ToolCallId } from '@panedesk/dsh-llm'
import ApprovalService from '@panedesk/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@panedesk/dsh-user-approval'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import PermissionPresetService from '@panedesk/dsh-permission-presets'
import type { SandboxMode } from '@panedesk/dsh-sandbox'
import { withFileLock } from '@panedesk/dsh-atomic-write'
import { PtcRuntime } from '@panedesk/dsh-ptc-runtime'
import TypertRegistry from '@panedesk/dsh-typert-registry'
import Gateway from '@panedesk/dsh-api-gateway'
import RemoteAccess from '@panedesk/dsh-api-remote-access'
import * as Remotes from '@panedesk/dsh-api-remotes'
import { Peer } from '@panedesk/dsh-client-connection'
import type { PtcRunRequest, PtcRunSpec, PtcRunResult } from '@panedesk/dsh-ptc-runtime'

const native = vi.hoisted(() => ({ additions: [] as string[], active: new Set<string>() }))
vi.mock('@panedesk/dsh-sandbox-windows-acl', async (original) => {
  const actual = await original<typeof import('@panedesk/dsh-sandbox-windows-acl')>()
  return {
    ...actual,
    AclWriteGrant: class {
      private readonly temporary: string[] = []
      static create() { return new this() }
      add(path: string, standing = false) {
        native.additions.push(path)
        native.active.add(path)
        if (!standing) this.temporary.push(path)
      }
      has(path: string) { return native.active.has(path) }
      revoke(path: string) { native.active.delete(path) }
      dispose() { for (const path of this.temporary) native.active.delete(path) }
    },
  }
})

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  native.additions.length = 0
  native.active.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test-binding'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 1000 } }
  async run(request: PtcRunSpec): Promise<PtcRunResult> {
    const write = request.bindings.find(binding => binding.global === 'tools')?.functions.write
    if (write === undefined) throw new Error('write binding is unavailable')
    await write({ file_path: join(request.cwd, 'result.txt'), content: 'confirmed' })
    return { logs: ['write completed'] }
  }
}

async function fixture(policy: 'ask' | 'never' = 'ask', platform: NodeJS.Platform = 'win32', mode?: SandboxMode, ptc = false, loader = false) {
  const home = mkdtempSync(join(tmpdir(), 'first-write-'))
  directories.push(home)
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_PERMISSION_MODE', undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: ptc ? 'ptc' : 'native' } })
  if (ptc) await ctx.plugin(BindingRuntime)
  provideWorkingDirectoryFixture(ctx)
  const platformMock = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  if (loader) {
    const config = join(home, 'cordis.yml')
    writeFileSync(config, JSON.stringify([
      { name: 'cordis:policy', config: { workspaceRoot: workspace } },
      { name: 'cordis:approval', config: { policy, workspaceWriteTimeoutMs: 100 } },
      { name: 'cordis:sandbox' },
      { name: 'cordis:fs', config: { cwd: workspace } },
      { name: 'cordis:tools' },
    ]))
    ctx.baseUrl = `${pathToFileURL(home).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, policy: SandboxPolicyService, approval: ApprovalService,
      sandbox: LocalSandboxProvider, fs: SandboxedFileSystem, tools: ToolFs,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
  } else {
    await ctx.plugin(SandboxPolicyService, { workspaceRoot: workspace, ...mode === undefined ? {} : { mode } })
    await ctx.plugin(ApprovalService, { policy, workspaceWriteTimeoutMs: 100 })
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    await ctx.plugin(ToolFs)
  }
  platformMock.mockRestore()
  const sandbox = ctx.sandbox
  if (!(sandbox instanceof LocalSandboxProvider)) throw new Error('Local sandbox was not mounted')
  sandbox.internals = { platform, windowsAclRunnerArgs: ['test-only-runner'] }
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('first-write'), {}, { cwd: workspace })
  agent.session.append('turn/start', { turn: 1 })
  let call = 0
  const write = (signal = new AbortController().signal) => ctx.tools.execute({
    signal, agent, name: ptc ? 'run_code' : 'write', callId: ToolCallId(`write-${++call}`),
    arguments: ptc ? { code: 'await tools.write({})', description: 'Write through the PTC binding' }
      : { file_path: join(workspace, 'result.txt'), content: 'confirmed' },
  })
  async function settings() {
    ctx.provide('shell', { sandboxMode: ctx.sandboxPolicy.defaultMode })
    await ctx.plugin(PermissionPresetService, { presets: {
      'read-only': { sandbox: 'read-only', approval: policy },
      'workspace-write': { sandbox: 'workspace-write', approval: policy },
    } })
    Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
    const inventory = async () => {
      const mock = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      try { return await ctx.permissionPresets.workspaceWriteAccess() } finally { mock.mockRestore() }
    }
    const revoke = async () => {
      const mock = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      try { await ctx.permissionPresets.revokeWorkspaceWrite(workspace) } finally { mock.mockRestore() }
    }
    return { inventory, revoke }
  }
  return { ctx, agent, workspace, write, sandbox, settings }
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

describe('Windows first workspace write confirmation', () => {
  it('keeps writes read-only until consent, persists first confirmation, and asks again after revocation', async () => {
    const { ctx, agent, workspace, write, settings } = await fixture()
    const { inventory, revoke } = await settings()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const asked = Promise.withResolvers<undefined>()
    const listener = vi.fn(async (_request: ApprovalRequest) => { asked.resolve(undefined); return answer.promise })
    ctx.on('approval/request', listener)
    const writing = write()
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledOnce() })
    await asked.promise
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
    expect(await inventory()).toEqual({ supported: true, entries: [] })
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ purpose: { type: 'workspace-write', workspace } })
    answer.resolve('allowed-once')
    expect((await writing).isError).not.toBe(true)
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('confirmed')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toMatchObject([{ workspace, source: 'first-confirmation' }])
    expect(agent.session.snapshotEvents().find(event => event.type === 'approval/asked')).toMatchObject({
      data: { purpose: { type: 'workspace-write', workspace } },
    })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
    expect((await inventory()).entries).toMatchObject([{ workspace, source: 'first-confirmation' }])
    expect(native.active.has(workspace)).toBe(true)
    await revoke()
    expect(native.active.has(workspace)).toBe(false)
    expect((await inventory()).entries).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
    listener.mockImplementation(async () => 'rejected')
    expect((await write()).isError).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })

  it.each(['allowed-once', 'rejected'] as const)('executes %s through a real cordis.yml Loader composition', async (outcome) => {
    const { ctx, workspace, write } = await fixture('ask', 'win32', undefined, false, true)
    ctx.on('approval/request', async () => outcome)
    const result = await write()
    expect(result.isError, text(result)).toBe(outcome !== 'allowed-once')
    expect(ctx.sandboxPolicy.workspaceAccess.isAuthorized(workspace)).toBe(outcome === 'allowed-once')
    expect(native.active.has(workspace)).toBe(outcome === 'allowed-once')
  })

  it('confirms an edit before changing the file', async () => {
    const { ctx, agent, workspace } = await fixture()
    const file = join(workspace, 'existing.txt')
    writeFileSync(file, 'before')
    const listener = vi.fn(async (_request: ApprovalRequest): Promise<ApprovalOutcome> => 'allowed-once')
    ctx.on('approval/request', listener)
    const result = await ctx.tools.execute({
      agent, name: 'edit', callId: ToolCallId('first-edit'), signal: new AbortController().signal,
      arguments: { file_path: file, old_string: 'before', new_string: 'after' },
    })
    expect(result.isError, text(result)).not.toBe(true)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ toolName: 'edit', purpose: { type: 'workspace-write', workspace } })
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect(native.active.has(workspace)).toBe(true)
  })

  it('keeps missing answerers read-only without materializing a grant', async () => {
    const { ctx, write } = await fixture()
    const result = await write()
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unavailable')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it('routes a PTC child write through the same dedicated confirmation and native grant', async () => {
    const { ctx, workspace, write } = await fixture('ask', 'win32', undefined, true)
    const listener = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    ctx.on('approval/request', listener)
    const result = await write()
    expect(result.isError).not.toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toMatchObject([{ workspace, source: 'first-confirmation' }])
    expect(native.active.has(workspace)).toBe(true)
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('confirmed')
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('keeps %s consent read-only with owner guidance', async (outcome) => {
    const { ctx, write } = await fixture()
    const listener = vi.fn(async () => outcome)
    ctx.on('approval/request', listener)
    const result = await write()
    expect(listener).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Settings > General > Windows workspace write access')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })

  it('discards a late allow after the caller cancels the pending confirmation', async () => {
    const { ctx, write } = await fixture()
    const controller = new AbortController()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const listener = vi.fn(() => answer.promise)
    ctx.on('approval/request', listener)
    const writing = write(controller.signal)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledOnce() })
    controller.abort(new Error('caller cancelled'))
    expect((await writing).isError).toBe(true)
    answer.resolve('allowed-once')
    await Promise.resolve()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it('fails closed when the answerer disconnects before answering', async () => {
    const { ctx, write } = await fixture()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const listener = vi.fn(() => answer.promise)
    ctx.on('approval/request', listener)
    const writing = write()
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledOnce() })
    answer.reject(new Error('answerer disconnected'))
    const result = await writing
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unavailable')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it('keeps a disconnected Remote Event owner read-only until the pending confirmation expires', async () => {
    const { ctx, workspace, write } = await fixture()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    await ctx.plugin(Remotes)
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    const controller = new AbortController()
    const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, controller.signal)
    const events = stream[Symbol.asyncIterator]()
    try {
      expect((await events.next()).value).toMatchObject({ type: 'ready' })
      const writing = write()
      expect((await events.next()).value).toMatchObject({
        type: 'waterfall', event: 'approval/request', request: { purpose: { type: 'workspace-write', workspace } },
      })
      controller.abort(new Error('owner transport disconnected'))
      await events.return?.()
      expect(ctx.typertGateway.hasLiveClient()).toBe(false)
      expect((await writing).isError).toBe(true)
      expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
      expect(native.additions).toEqual([])
    } finally {
      controller.abort()
      await events.return?.()
    }
  })

  it('withdraws an unanswered confirmation at its configured deadline', async () => {
    const { ctx, write } = await fixture()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let signal: AbortSignal | undefined
    ctx.on('approval/request', (request) => { signal = request.signal; return answer.promise })
    const result = await write()
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cancelled')
    expect(signal?.aborted).toBe(true)
    answer.resolve('allowed-once')
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it('does not persist consent when cancellation wins while waiting for the record lock', async () => {
    const { ctx, workspace, write } = await fixture()
    const access = ctx.sandboxPolicy.workspaceAccess
    const controller = new AbortController()
    const locked = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    mkdirSync(join(workspace, '..', 'windows-workspace-write'), { recursive: true })
    const holding = withFileLock(access.recordPath(workspace), async () => {
      locked.resolve(undefined)
      await release.promise
    })
    await locked.promise
    const authorize = vi.spyOn(access, 'authorize')
    ctx.on('approval/request', async () => 'allowed-once')
    const writing = write(controller.signal)
    try {
      await vi.waitFor(() => { expect(authorize).toHaveBeenCalledOnce() })
      controller.abort(new Error('cancel before consent commit'))
    } finally {
      release.resolve(undefined)
      await holding
    }
    expect((await writing).isError).toBe(true)
    expect(access.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('honors the explicit %s mode without first-write prompts', async (mode) => {
    const { ctx, write } = await fixture('ask', 'win32', mode)
    const listener = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    ctx.on('approval/request', listener)
    const result = await write()
    expect(result.isError).toBe(mode === 'read-only')
    expect(listener).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('honors a session %s override without first-write prompts', async (mode) => {
    const { ctx, agent, write } = await fixture()
    agent.session.append('sandbox/mode', { mode })
    const listener = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    ctx.on('approval/request', listener)
    expect((await write()).isError).toBe(mode === 'read-only')
    expect(listener).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })

  it('honors an explicit read-only choice made while confirmation is pending', async () => {
    const { ctx, agent, write } = await fixture()
    ctx.on('approval/request', async () => {
      agent.session.append('sandbox/mode', { mode: 'read-only' })
      return 'allowed-once'
    })
    expect((await write()).isError).toBe(true)
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
    expect(native.additions).toEqual([])
  })

  it('does not prompt an unattended session', async () => {
    const { ctx, write } = await fixture('never')
    const listener = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    ctx.on('approval/request', listener)
    expect((await write()).isError).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })

  it.each(['linux', 'darwin'] as const)('does not change the %s default', async (platform) => {
    const { ctx, write } = await fixture('ask', platform)
    const listener = vi.fn(async (): Promise<ApprovalOutcome> => 'rejected')
    ctx.on('approval/request', listener)
    expect((await write()).isError).not.toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(ctx.sandboxPolicy.workspaceAccess.list()).toEqual([])
  })
})
