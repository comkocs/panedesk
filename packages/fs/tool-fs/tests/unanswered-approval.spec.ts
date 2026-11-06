/** Unanswered read-only escalation never reaches the filesystem mutation. */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import WorkingDirectory from '@panedesk/dsh-working-directory'
import ApprovalService, { type ApprovalOutcome } from '@panedesk/dsh-user-approval'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import { deadline, timeoutOf } from '@panedesk/dsh-timeout'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'unanswered-approval-'))
  directories.push(workspace)
  const target = join(workspace, 'notes.txt')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  const config = join(workspace, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'cordis:policy', config: { mode: 'read-only', workspaceRoot: workspace } },
    { name: 'cordis:approval', config: { policy: 'ask' } },
    { name: 'cordis:fs', config: { cwd: workspace } },
    { name: 'cordis:directory', config: { defaultDirectory: workspace } },
    { name: 'cordis:tools' },
  ]))
  ctx.baseUrl = `${pathToFileURL(workspace).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, policy: SandboxPolicyService, approval: ApprovalService,
    fs: SandboxedFileSystem, directory: WorkingDirectory, tools: ToolFs,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const adapter = new MockAdapter([
    toolCallResponse('unanswered-write', 'write', {
      file_path: target, content: 'must not be written',
      sandbox_permissions: 'workspace-write', justification: 'Write the requested workspace note.',
    }),
    textResponse('The write did not receive approval.'),
  ])
  ctx.llm.registerAdapter(['unanswered-fixture'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('unanswered-approval'), {
    provider: 'unanswered-fixture', model: 'scripted',
  }, { cwd: workspace })
  const mutation = vi.spyOn(ctx.fs, 'writeText')
  const observed = vi.fn()
  ctx.on('fs/observed', (subject) => {
    if (subject.displayPath === target) observed()
  })
  const start = () => {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Write notes.txt.' }], source: { kind: 'user' },
    }))
  }
  const assertDenied = async (outcome: ApprovalOutcome, ending: object) => {
    await expect(access(target)).rejects.toHaveProperty('code', 'ENOENT')
    expect(mutation).not.toHaveBeenCalled()
    expect(observed).not.toHaveBeenCalled()
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'approval/asked').map(event => event.data.toolName)).toEqual(['write'])
    expect(events.filter(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once')).toEqual([])
    expect(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual([outcome])
    const results = events.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.isError)).toEqual([true])
    expect(results.map(event => event.data.message.toolCallId)).toEqual(['unanswered-write'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([ending])
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
  }
  return { ctx, agent, start, target, mutation, assertDenied }
}

it('refuses a write when no approval client or answerer is available', async () => {
  const f = await fixture()
  f.start()
  await f.agent.whenIdle()
  await f.assertDenied('unavailable', { kind: 'completed' })
})

it.each(['user', 'parent'] as const)('keeps an unrendered unanswered panel denied until the turn is aborted by %s', async (kind) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  f.ctx.on('approval/request', () => { entered.resolve(undefined); return answer.promise })
  f.start()
  try {
    await entered.promise
    await expect(access(f.target)).rejects.toHaveProperty('code', 'ENOENT')
    expect(f.mutation).not.toHaveBeenCalled()
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([])
    f.agent.cancel({ kind })
    await f.agent.whenIdle()
    await f.assertDenied('cancelled', { kind: 'aborted', reason: { kind } })
  } finally {
    f.agent.cancel({ kind: 'user' })
    answer.resolve('unavailable')
    await f.agent.whenIdle()
  }
})

it.each(['cancelled', 'timed out'] as const)('refuses a write when the unanswered approval wait is %s without aborting the turn', async (mode) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  const cancellation = new AbortController()
  f.ctx.on('approval/request', () => { entered.resolve(undefined); return answer.promise })
  f.ctx.on('tools/execute', async (exec, next) => {
    using wait = deadline(exec.signal, mode === 'timed out' ? 100 : 0, 'APPROVAL_WAIT_TIMEOUT')
    const upstream = exec.signal
    exec.signal = AbortSignal.any([wait.signal, cancellation.signal])
    try { return await next() } finally { exec.signal = upstream }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  f.start()
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(60_000)
    // Ordinary escalation has no implicit approval deadline, unlike workspace consent.
    if (mode === 'cancelled') {
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([])
      cancellation.abort(new Error('approval wait withdrawn'))
    }
    await f.agent.whenIdle()
    await f.assertDenied('cancelled', { kind: 'completed' })
  } finally {
    cancellation.abort()
    f.agent.cancel({ kind: 'user' })
    answer.resolve('unavailable')
    await f.agent.whenIdle()
  }
})

it('aborts the unanswered turn when its owning deadline expires', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  f.ctx.on('approval/request', () => { entered.resolve(undefined); return answer.promise })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  f.start()
  try {
    await entered.promise
    using turn = deadline(undefined, 100, 'TURN_TIMEOUT')
    turn.signal.addEventListener('abort', () => {
      f.agent.cancel({ kind: 'hook', reason: 'Turn deadline expired' })
    }, { once: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(timeoutOf(turn.signal, 'TURN_TIMEOUT')?.timeoutMs).toBe(100)
    await f.agent.whenIdle()
    await f.assertDenied('cancelled', { kind: 'aborted', reason: { kind: 'hook', reason: 'Turn deadline expired' } })
  } finally {
    f.agent.cancel({ kind: 'user' })
    answer.resolve('unavailable')
    await f.agent.whenIdle()
  }
})
