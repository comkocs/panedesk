/** Real tool dispatches retain protected inputs, and uncovered catalog entries fail closed. */
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFailed, onTestFinished, vi, type TestContext } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import { provideWorkingDirectoryFixture } from '@panedesk/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type StreamChunk } from '@panedesk/dsh-llm'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import * as StrReplaceEditor from '@panedesk/dsh-tool-str-replace-editor'
import LocalSubprocessRuntime from '@panedesk/dsh-subprocess-local'
import * as ToolFsSearch from '@panedesk/dsh-tool-fs-search'
import AgentRegistry, { type Agent } from '@panedesk/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@panedesk/dsh-session'
import { createInboxStub } from '@panedesk/dsh-agent-loop-testkit'
import * as WorkspaceDependencies from '@panedesk/dsh-tool-workspace-dependencies'
import GoalService from '@panedesk/dsh-goal'
import * as ToolGoal from '@panedesk/dsh-tool-goal'
import AgentLoop, { turnBoundaryProjectionDefinition } from '@panedesk/dsh-agent-loop'
import Sandbox from '@panedesk/dsh-sandbox-local'
import BashExecutor from '@panedesk/dsh-bash-sandbox'
import * as ToolBash from '@panedesk/dsh-tool-bash'
import * as ShellEnv from '@panedesk/dsh-shell-env'
import NodeRuntime from '@panedesk/dsh-ptc-runtime-node'
import McpResources, { type McpResourceProvider } from '@panedesk/dsh-mcp-resources'
import WebRuntime, { type WebFetchRequest, type WebFetchResult, type WebSearchRequest, type WebSearchResult } from '@panedesk/dsh-web'
import * as ToolWeb from '@panedesk/dsh-tool-web'
import SkillRegistry from '@panedesk/dsh-skill'
import * as SkillFilesystem from '@panedesk/dsh-skill-filesystem'
import * as ToolSkill from '@panedesk/dsh-tool-skill'
import UserQuestions from '@panedesk/dsh-user-questions'
import * as ToolAskUser from '@panedesk/dsh-tool-ask-user'
import TerminalSessionService, { type TerminalBackendSession } from '@panedesk/dsh-terminal'
import * as TerminalBash from '@panedesk/dsh-terminal-bash'
import * as ToolTerminal from '@panedesk/dsh-tool-terminal'
import { registerListSubagentModels } from '@panedesk/dsh-tool-subagent/src/list-models.ts'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@panedesk/dsh-session-query-sqlite'
import * as ToolSessionQuery from '@panedesk/dsh-tool-session-query'
import * as ToolTodo from '@panedesk/dsh-tool-todo'
import WorkingDirectory from '@panedesk/dsh-working-directory'
import * as ToolWorkingDirectory from '@panedesk/dsh-tool-working-directory'
import Lsp from '@panedesk/dsh-lsp'
import * as LspStdio from '@panedesk/dsh-lsp-stdio'
import * as ToolLsp from '@panedesk/dsh-tool-lsp'
import * as PersistentBash from '@panedesk/dsh-tool-bash-persistent'
import * as PersistentPwsh from '@panedesk/dsh-tool-pwsh-persistent'
import * as ToolPresent from '@panedesk/dsh-tool-present'
import PlanModeController from '@panedesk/dsh-plan-mode'
import LocalAttachmentStore from '@panedesk/dsh-attachment-local'
import PluginMarket from '@panedesk/dsh-plugin-market'
import * as MarketTool from '@panedesk/dsh-plugin-market/src/tools.ts'
import BrowserUseRegistry from '@panedesk/dsh-browser-use'
import * as Stagehand from '@panedesk/dsh-experimental-browser-use-stagehand-native'
import SubagentRuntime, { type SubagentRun } from '@panedesk/dsh-subagent'
import * as ToolSubagent from '@panedesk/dsh-tool-subagent'
import * as SubagentControl from '@panedesk/dsh-tool-subagent-control'
import * as SubagentList from '@panedesk/dsh-tool-subagent-control/list-agents'
import WorktreeService from '@panedesk/dsh-experimental-worktree'
import * as ToolWorktree from '@panedesk/dsh-experimental-tool-worktree'
import PwshExecutor from '@panedesk/dsh-pwsh-sandbox'
import * as ToolPwsh from '@panedesk/dsh-tool-pwsh'
import WorkflowPtc from '@panedesk/dsh-workflow-ptc'
import * as ToolWorkflow from '@panedesk/dsh-tool-workflow'
import * as ToolRalph from '@panedesk/dsh-tool-ralph'
import * as SeatLocal from '@panedesk/dsh-seat-local'
import * as SeatEngine from '@panedesk/dsh-seat-engine'
import SessionLedger from '@panedesk/dsh-session-ledger'
import SessionTitle from '@panedesk/dsh-session-title'
import PermissionPresets from '@panedesk/dsh-permission-presets'
import Approval from '@panedesk/dsh-user-approval'
import * as InstructionSubscriptions from '@panedesk/dsh-instruction-subscriptions'
import type { AuthorizationRef, SeatDefinition, SeatName, SeatOperationId, SeatPrincipalId, SeatProjectId } from '@panedesk/dsh-seat'
import ScheduleService from '@panedesk/dsh-schedule'
import * as ToolSchedule from '@panedesk/dsh-tool-schedule'
import SessionController from '@panedesk/dsh-api-session-controller'
import DefaultModel from '@panedesk/dsh-agent-default-model'
import LocalCredentials from '@panedesk/dsh-credentials-local'
import * as Connection from '@panedesk/dsh-client-connection'
import Commands from '@panedesk/dsh-commands'
import FileUploads from '@panedesk/dsh-client-file-upload'
import RemoteAccess from '@panedesk/dsh-api-remote-access'
import WorkspaceRegistry from '@panedesk/dsh-workspace'
import TypertRegistry from '@panedesk/dsh-typert-registry'
import * as ToolSeat from '@panedesk/dsh-tool-seat'
import * as ToolSeatMessages from '@panedesk/dsh-tool-seat-messages'
import MessageDelivery from '@panedesk/dsh-message-delivery-local'
import Storage from '@panedesk/dsh-storage'
import * as StorageJson from '@panedesk/dsh-storage-json'
import * as StorageDomain from '@panedesk/dsh-storage-domain'
import TeamService from '@panedesk/dsh-experimental-agent-team'
import * as ToolTeam from '@panedesk/dsh-experimental-tool-agent-team'
import LocalJobRegistry from '@panedesk/dsh-jobs-local'
import type { JobOutcome } from '@panedesk/dsh-jobs'
import * as ToolJobs from '@panedesk/dsh-tool-jobs'
import { CordisInspectRegistryService } from '@panedesk/dsh-cordis-host-runner'
import * as ToolCordis from '@panedesk/dsh-tool-cordis'
import * as CordisProviders from '@panedesk/dsh-tool-cordis/host'
import { collectToolCatalog } from '../../../../scripts/gen-tool-catalog.ts'
import PluginManager from '../src/index.ts'
import * as ManagerTool from '../src/tools.ts'

import { pendingAdmissionEvidence, requireAdmissionSandbox } from './admission-evidence.ts'

const executed = new Set<string>()
const unavailableLocally = new Set<string>()
let nativeAvailable: boolean | undefined

function nativeEvidence(test: TestContext, key: string): void {
  nativeAvailable ??= spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--', 'true'], {
    timeout: 5000, stdio: 'ignore',
  }).status === 0
  if (requireAdmissionSandbox(process.env.PANEDESK_CI_NATIVE_SANDBOX, nativeAvailable)) return
  const reason = 'Local native admission evidence skipped: bubblewrap is absent or cannot create a sandbox.'
  unavailableLocally.add(key)
  console.warn(`${key}: ${reason}`)
  test.skip(reason)
}

it('requires native admission only for the dedicated required marker, not generic CI', () => {
  vi.stubEnv('CI', 'true')
  onTestFinished(() => { vi.unstubAllEnvs() })
  expect(requireAdmissionSandbox(undefined, false)).toBe(false)
  expect(requireAdmissionSandbox('true', false)).toBe(false)
  expect(requireAdmissionSandbox('optional', false)).toBe(false)
})

it('fails rather than skipping when required native admission has no usable bubblewrap', () => {
  expect(() => requireAdmissionSandbox('required', false)).toThrow('refusing to skip')
  expect(requireAdmissionSandbox('required', true)).toBe(true)
})

async function fixture(mode: 'native' | 'ptc' = 'native', realDirectory = false, externalProfile = false) {
  const root = mkdtempSync(join(tmpdir(), 'tool-admission-'))
  const ctx = new Context()
  if (!realDirectory) provideWorkingDirectoryFixture(ctx)
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const dir = join(externalProfile ? home : workspace, 'profiles', 'test')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const profile: ProfileContext = {
    name: 'test', dir, home, patchPath: join(dir, 'cordis.patch.yml'), cwd: workspace,
    installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  const target = profile.patchPath
  const original = 'protected original\n'
  writeFileSync(target, original)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode })
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(StrReplaceEditor)
  const call = (name: string, args: unknown) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`admission-${name}`), signal: new AbortController().signal,
  })
  return { ctx, root, workspace, target, original, call }
}

it('read cannot write a protected input through extra model arguments', async () => {
  const { target, original, call } = await fixture()
  const result = await call('read', { file_path: target, content: 'model replacement', new_string: 'replacement' })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('protected original')
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-fs:read')
})

it.each(['write', 'edit', 'str_replace_editor'])('%s denies a protected input through the real filesystem', async (name) => {
  const { ctx, target, original, call } = await fixture()
  expect(ctx.sandboxPolicy.resolve().protectedPaths).toContain(dirname(target))
  expect((await call('read', { file_path: target })).isError).toBe(false)
  const args = name === 'write' ? { file_path: target, content: 'model replacement' }
    : name === 'edit' ? { file_path: target, old_string: original, new_string: 'model replacement' }
      : { command: 'str_replace', path: target, old_str: original, new_str: 'model replacement' }
  const result = await call(name, args)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('protected host path')
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add(name === 'str_replace_editor'
    ? '@panedesk/dsh-tool-str-replace-editor:str_replace_editor' : `@panedesk/dsh-tool-fs:${name}`)
})

it('glob cannot write protected inputs through model-controlled patterns', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tool-fs-search:glob')
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  const result = await call('glob', { path: dirname(target), pattern: '**/*', content: 'model replacement', output: target })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('cordis.patch.yml')
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-fs-search:glob')
})

it('grep cannot write protected inputs through model-controlled patterns', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tool-fs-search:grep')
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  const result = await call('grep', { path: target, pattern: 'protected', content: 'model replacement', output: target })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('protected original')
  expect(readFileSync(target, 'utf8')).toBe(original)
  const injection = await call('grep', { path: target, pattern: `$(printf replaced > '${target}')` })
  expect(injection.isError).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-fs-search:grep')
})

it.for(['glob', 'grep'])('%s confines the search process and retains protected inputs', async (name, test) => {
  nativeEvidence(test, `@panedesk/dsh-tool-fs-search:${name}`)
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  const confine = vi.spyOn(ctx.sandbox, 'confine')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const result = await call(name, name === 'glob'
    ? { path: dirname(target), pattern: '**/*', output: target }
    : { path: target, pattern: 'protected', output: target })
  expect(confine).toHaveBeenCalledTimes(1)
  expect(confine.mock.calls[0]?.[1]).toMatchObject({ mode: 'workspace-write' })
  const confinement = confine.mock.results[0]
  if (confinement?.type !== 'return') throw new Error('Confinement did not return a result')
  const confined = await confinement.value
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: confined?.argv }))
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add(`@panedesk/dsh-tool-fs-search:${name}`)
})

it('job_list cannot write a protected input through extra model arguments', async () => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  const result = await call('job_list', { file_path: target, content: 'model replacement' })
  expect(result.isError).toBe(false)
  expect(result.value).toEqual([])
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-jobs:job_list')
})

it('job_output cannot write a protected input through extra model arguments', async () => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  const settled = Promise.withResolvers<JobOutcome>()
  const id = ctx.jobs.start({ kind: 'bash', label: 'in-memory admission output', run(handle) {
    handle.append('admission output')
    return { done: settled.promise, cancel() { settled.resolve({ status: 'completed' }) } }
  } })
  settled.resolve({ status: 'completed' })
  await ctx.jobs.wait(id, 1000)
  const result = await call('job_output', { job_id: id, file_path: target, content: 'model replacement' })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('admission output')
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-jobs:job_output')
})

it('cordis_inspect_list cannot write a protected input through extra model arguments', async () => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(CordisInspectRegistryService, 1000)
  await ctx.plugin(CordisProviders)
  await ctx.plugin(ToolCordis)
  const result = await call('cordis_inspect_list', { file_path: target, content: 'model replacement' })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('Service')
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-cordis:cordis_inspect_list')
})

it('get_goal cannot write protected inputs or append goal state through extra model arguments', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal, {})
  const session = ctx.sessions.create(SessionId('goal-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  const before = session.seq
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'get_goal', arguments: { file_path: target, content: 'model replacement', objective: 'replace goal' },
    agent, callId: ToolCallId('goal-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ goal: null })
  expect(session.seq).toBe(before)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-goal:get_goal')
})

it.each(['create_goal', 'update_goal'])('%s denies state writes without current human authority', async (name) => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal, {})
  const session = ctx.sessions.create(SessionId(`goal-admission-${name}`))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  const goal = ctx.goals.create(agent, { objective: 'Retain the current objective' })
  const before = session.seq
  const args = name === 'create_goal' ? { objective: 'Unauthorized replacement' }
    : { goal_id: goal.id, revision: goal.revision, action: 'edit', objective: 'Unauthorized replacement' }
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: args, agent, callId: ToolCallId(`goal-admission-${name}`), signal: new AbortController().signal,
  }))
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires a direct human turn on a top-level agent')
  expect(ctx.goals.get(agent)).toEqual(goal)
  expect(session.seq).toBe(before)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add(`@panedesk/dsh-tool-goal:${name}`)
})

it.each(['create_goal', 'update_goal'])('%s stores authorized goal changes without model-controlled storage paths', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  const storageRoot = join(root, 'goal-sessions')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal, {})
  const alias = join(workspace, 'goal-output-link')
  symlinkSync(dirname(target), alias, 'dir')
  for (const [index, path] of [target, '../protected-input', join(alias, 'cordis.patch.yml')].entries()) {
    const session = ctx.sessions.create(SessionId(`goal-storage-${name}-${index}`), { meta: { cwd: workspace } })
    const writer = await ctx.sessionPersistence.create(session.header)
    const agent: Agent = {
      id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
      send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    try {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Maintain this project goal.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const goal = name === 'update_goal' ? ctx.goals.create(agent, { objective: 'Initial objective' }) : undefined
      const args = goal === undefined ? { objective: path }
        : { goal_id: goal.id, revision: goal.revision, action: 'edit', objective: path }
      const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name, arguments: { ...args, file_path: path, root: path, output_path: path }, agent,
        callId: ToolCallId(`goal-storage-${index}`), signal: new AbortController().signal,
      }))
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(ctx.goals.get(agent)?.objective).toBe(path)
      await ctx.sessions.flush(session)
      const directory = await ctx.sessionPersistence.sidecarDirectory?.(session.id)
      if (directory === undefined) throw new Error('Goal session was not persisted')
      const suffix = relative(storageRoot, directory)
      expect(isAbsolute(suffix)).toBe(false)
      expect(suffix.split(/[\\/]/)).not.toContain('..')
      const persisted = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
      expect(persisted).toContain('goal/change')
      expect(persisted).toContain(JSON.stringify(path))
      expect(readFileSync(target, 'utf8')).toBe(original)
    } finally { await writer.close() }
  }
  executed.add(`@panedesk/dsh-tool-goal:${name}`)
})

it('cordis_inspect_query reads the real host service catalog without filesystem writes', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('inspect-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  await ctx.plugin(CordisInspectRegistryService, 1000)
  await ctx.plugin(CordisProviders)
  const write = vi.spyOn(ctx.fs, 'writeText')
  const edit = vi.spyOn(ctx.fs, 'editText')
  await ctx.plugin(ToolCordis)
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'cordis_inspect_query',
    arguments: { platform: 'host', provider: 'Service', method: 'listService', input: { service: 'tools' }, file_path: target, content: 'replacement' },
    agent, callId: ToolCallId('inspect-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.content)).toContain('tools')
  expect(write).not.toHaveBeenCalled()
  expect(edit).not.toHaveBeenCalled()
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-cordis:cordis_inspect_query')
})

it('load_workspace_dependencies denies replacing a protected runtime target', async () => {
  const { ctx, root, target, original, call } = await fixture()
  const source = join(root, 'runtime-source')
  const manifest: WorkspaceDependencies.PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    python: '3.12.14', pythonPackages: {},
  }
  const paths = WorkspaceDependencies.workspaceDependencyPaths(source, manifest)
  mkdirSync(dirname(paths.python), { recursive: true })
  mkdirSync(paths.pythonPackages, { recursive: true })
  writeFileSync(paths.python, 'offline interpreter fixture')
  writeFileSync(join(source, 'runtime.json'), JSON.stringify(manifest))
  await ctx.plugin(WorkspaceDependencies, { source, root: dirname(target) })
  const result = await call('load_workspace_dependencies', {})
  expect(result.isError).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-workspace-dependencies:load_workspace_dependencies')
})

it('load_workspace_dependencies ignores model installation paths and sources', async () => {
  const { ctx, root, target, original, call } = await fixture()
  const source = join(root, 'runtime-source')
  const destination = join(root, 'application-home', 'runtime')
  const alias = join(root, 'model-output-link')
  symlinkSync(dirname(target), alias, 'dir')
  const manifest: WorkspaceDependencies.PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    python: '3.12.14', pythonPackages: {},
  }
  const sourcePaths = WorkspaceDependencies.workspaceDependencyPaths(source, manifest)
  const installedPaths = WorkspaceDependencies.workspaceDependencyPaths(destination, manifest)
  mkdirSync(dirname(sourcePaths.python), { recursive: true })
  mkdirSync(sourcePaths.pythonPackages, { recursive: true })
  writeFileSync(sourcePaths.python, 'offline interpreter fixture')
  writeFileSync(join(source, 'runtime.json'), JSON.stringify(manifest))
  await ctx.plugin(WorkspaceDependencies, { source, root: destination })
  for (const path of [target, '../protected-input', join(alias, 'cordis.patch.yml')]) {
    const result = await call('load_workspace_dependencies', {
      root: path, source: path, file_path: path, output_path: path,
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toEqual(installedPaths)
    expect(readFileSync(installedPaths.python, 'utf8')).toBe('offline interpreter fixture')
    expect(readFileSync(join(destination, 'runtime.json'), 'utf8')).toBe(JSON.stringify(manifest))
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  executed.add('@panedesk/dsh-tool-workspace-dependencies:load_workspace_dependencies')
})

it('bash denies a protected input through the real local process sandbox', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tool-bash:bash')
  const { ctx, workspace, target, original, call } = await fixture()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(BashExecutor, { cwd: workspace, timeoutMs: 10000, graceMs: 200 })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolBash)
  const allowed = join(workspace, 'permitted.txt')
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
  const control = await call('bash', { command: `printf allowed > ${quote(allowed)}`, description: 'Write a workspace control' })
  expect(control.isError, JSON.stringify(control.content)).toBe(false)
  expect(readFileSync(allowed, 'utf8')).toBe('allowed')
  const result = await call('bash', { command: `printf replacement > ${quote(target)}`, description: 'Attempt protected input replacement' })
  expect(JSON.stringify(result.content)).toMatch(/denied|read-only|protected/i)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-bash:bash')
})

it('run_code denies a protected input through the real Node process sandbox', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tools:run_code')
  const { ctx, workspace, target, original, call } = await fixture('ptc')
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(NodeRuntime, { timeoutMs: 10000, graceMs: 200 })
  const allowed = join(workspace, 'permitted-node.txt')
  const control = await call('run_code', {
    code: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(allowed)}, 'allowed')`,
    description: 'Write a workspace control',
  })
  expect(control.isError, JSON.stringify(control.content)).toBe(false)
  expect(readFileSync(allowed, 'utf8')).toBe('allowed')
  const result = await call('run_code', {
    code: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'replacement')`,
    description: 'Attempt protected input replacement',
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(true)
  expect(JSON.stringify(result.content)).toMatch(/denied|read-only|protected/i)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tools:run_code')
})

it('plugin_manager denies protected profile changes without an owner decision through the real Loader', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manager-admission-'))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"admission-installation","dependencies":{}}\n')
  initProfile(dir, [])
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[{"insert":[{"id":"manager","name":"cordis:manager"},{"id":"manager-tool","name":"cordis:managerTool"}]}]\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, home, patchPath, cwd: home, installAnchor: anchor,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    provideWorkingDirectoryFixture(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
    ctx.loader.builtins.managerTool = ManagerTool
    ctx.plugin(SessionProjectionRegistry)
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(SessionStore)
    ctx.plugin(AgentRegistry)
    ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: home })
  })
  expect(ctx.get('pluginManager')).toBeDefined()
  const session = ctx.sessions.create(SessionId('manager-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  const manifestPath = join(dir, 'package.json')
  const manifest = readFileSync(manifestPath, 'utf8')
  const patch = readFileSync(patchPath, 'utf8')
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'extra', enabled: false },
    agent, callId: ToolCallId('manager-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('Plugin changes require owner approval, but no approval service is composed')
  expect(readFileSync(manifestPath, 'utf8')).toBe(manifest)
  expect(readFileSync(patchPath, 'utf8')).toBe(patch)
  executed.add('@panedesk/dsh-plugin-manager:plugin_manager')
})

it.each(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])(
  '%s delegates resource reads without a model-controlled write destination', async (name) => {
    const { ctx, target, original, call } = await fixture()
    await ctx.plugin(McpResources)
    const uri = 'admission://protected-input'
    const resource = { name: 'protected-input', uri }
    const request = vi.fn<McpResourceProvider['request']>(async (input) => {
      switch (input.method) {
        case 'resources/list': return { resources: [resource] }
        case 'resources/templates/list': return { resourceTemplates: [] }
        case 'resources/read': {
          if (input.uri !== uri) throw new Error('Unknown resource')
          return { contents: [{ uri, text: 'Owner-configured resource content' }] }
        }
      }
    })
    ctx.mcpResources.register('admission-provider', { request })
    const result = await call(name, {
      server: 'admission-provider', uri, cursor: 'opaque-cursor', file_path: target, content: 'replacement',
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toEqual(name === 'read_mcp_resource'
      ? { method: 'resources/read', uri }
      : { method: name === 'list_mcp_resources' ? 'resources/list' : 'resources/templates/list', cursor: 'opaque-cursor' })
    expect(result).toMatchObject({ value: name === 'read_mcp_resource'
      ? { contents: [{ uri, text: 'Owner-configured resource content' }] }
      : name === 'list_mcp_resources' ? { resources: [resource] } : { resourceTemplates: [] } })
    expect(readFileSync(target, 'utf8')).toBe(original)
    executed.add(`@panedesk/dsh-mcp-resources:${name}`)
  },
)

it.each(['web_search', 'web_fetch'])('%s delegates retrieval without a model-controlled write destination', async (name) => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(WebRuntime, {})
  const url = 'https://admission.invalid/'
  const search = vi.fn(async (request: WebSearchRequest): Promise<WebSearchResult> => {
    if (request.query !== 'admission') throw new Error('Unknown fixture query')
    return { sources: [{ url, title: 'Admission fixture' }], truncated: false }
  })
  const fetch = vi.fn(async (request: WebFetchRequest): Promise<WebFetchResult> => {
    if (request.url !== url) throw new Error('Unknown fixture URL')
    return { url, statusCode: 200, body: { kind: 'text', content: 'retrieved' }, truncated: false }
  })
  ctx.web.registerSearchProvider({ id: 'admission-search', available: () => true, search })
  ctx.web.registerFetchProvider({ id: 'admission-fetch', available: () => true, fetch })
  await ctx.plugin(ToolWeb, { searchMaxResults: 3 })
  const result = await call(name, {
    ...name === 'web_search' ? { queries: ['admission'] } : { url },
    file_path: target, output_path: '../protected-input', content: 'replacement',
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  if (name === 'web_search') {
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0]?.[0]).toEqual({ query: 'admission', maxResults: 3 })
    expect(fetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ value: { sources: [{ url, title: 'Admission fixture' }], truncated: false } })
  } else {
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toEqual({ url })
    expect(search).not.toHaveBeenCalled()
    expect(result).toMatchObject({ value: { body: { kind: 'text', content: 'retrieved' } } })
  }
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add(`@panedesk/dsh-tool-web:${name}`)
})

it('job_kill only cancels jobs owned by the calling session', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  const agents: Agent[] = []
  for (const name of ['caller', 'other']) {
    const session = ctx.sessions.create(SessionId(`job-admission-${name}`))
    const agent: Agent = {
      id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
      send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    agents.push(agent)
  }
  const caller = agents[0]!
  const other = agents[1]!
  const jobs = [caller.id, other.id, undefined].map((owner) => {
    const settled = Promise.withResolvers<JobOutcome>()
    const cancel = vi.fn(() => { settled.resolve({ status: 'killed' }) })
    const id = ctx.jobs.start({ kind: 'bash', label: 'session-owned cancellation',
      ...owner === undefined ? {} : { owner }, run: () => ({ done: settled.promise, cancel }) })
    onTestFinished(() => { settled.resolve({ status: 'completed' }) })
    return { id, cancel }
  })
  for (const [index, job] of jobs.entries()) {
    const result = await ctx.agents.withInitiator(caller, () => ctx.tools.execute({
      name: 'job_kill', arguments: { job_id: job.id, reason: target, file_path: target, content: 'replacement' },
      agent: caller, callId: ToolCallId(`job-admission-${index}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(index !== 0)
    expect(job.cancel).toHaveBeenCalledTimes(index === 0 ? 1 : 0)
  }
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-jobs:job_kill')
})

it('skill reads the filesystem provider without a model-controlled write destination', async () => {
  const { ctx, workspace, target, original, call } = await fixture()
  const skillsRoot = join(workspace, 'skills')
  const source = join(skillsRoot, 'admission-skill', 'SKILL.md')
  const body = '---\nname: admission-skill\ndescription: Admission fixture\n---\n\nRead-only fixture content.\n'
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, body)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFilesystem, {
    dshHome: join(workspace, 'skill-home'), agentsHome: join(workspace, 'agents-home'),
    customSkillDirs: [skillsRoot], includeDefaultRoots: false, watch: false,
  })
  await ctx.plugin(ToolSkill, {})
  const write = vi.spyOn(ctx.fs, 'writeText')
  const edit = vi.spyOn(ctx.fs, 'editText')
  const result = await call('skill', { name: 'admission-skill', file_path: target, content: 'replacement' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result).toMatchObject({ value: { name: 'admission-skill', provider: 'filesystem', content: 'Read-only fixture content.' } })
  for (const name of ['../admission-skill', target]) {
    expect((await call('skill', { name })).isError).toBe(true)
  }
  expect(write).not.toHaveBeenCalled()
  expect(edit).not.toHaveBeenCalled()
  expect(readFileSync(source, 'utf8')).toBe(body)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-skill:skill')
})

it('ask_user_question denies an unregistered caller before invoking a human provider', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(ToolAskUser, { mode: 'legacy' })
  const session = ctx.sessions.create(SessionId('question-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  let invoked = false
  ctx.on('user-questions/request', () => {
    invoked = true
    return Promise.resolve({ answers: [] })
  })
  const before = session.seq
  const result = await ctx.tools.execute({
    name: 'ask_user_question', arguments: { questions: [{ id: 'confirm', question: 'Replace the protected input?' }] },
    agent, callId: ToolCallId('question-admission'), signal: new AbortController().signal,
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires the exact live calling agent')
  expect(invoked).toBe(false)
  expect(session.seq).toBe(before)
  expect(readFileSync(target, 'utf8')).toBe(original)
})

it('ask_user_question delegates a live caller question without filesystem writes', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(ToolAskUser, { mode: 'legacy' })
  const session = ctx.sessions.create(SessionId('live-question-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  let requests = 0
  ctx.on('user-questions/request', (request) => {
    requests += 1
    expect(request.agent).toBe(agent)
    expect(request.questions).toEqual([{ id: 'confirm', question: 'Retain the protected input?' }])
    return Promise.resolve({ answers: [{ id: 'confirm', selected: ['Yes'] }] })
  })
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'ask_user_question', arguments: {
      questions: [{ id: 'confirm', question: 'Retain the protected input?', file_path: target }],
      file_path: target, content: 'replacement',
    },
    agent, callId: ToolCallId('live-question-admission'), signal: new AbortController().signal,
  }))
  expect(result).toMatchObject({ isError: false, value: { answers: [{ id: 'confirm', selected: ['Yes'] }] } })
  expect(requests).toBe(1)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-ask-user:ask_user_question')
})

it.for(['terminal_open', 'terminal_send'])('%s denies protected writes through the real terminal backend', async (name, test) => {
  nativeEvidence(test, `@panedesk/dsh-tool-terminal:${name}`)
  const { ctx, target, original, workspace } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(TerminalBash, { timeoutMs: 5000 })
  await ctx.plugin(ToolTerminal)
  const session = ctx.sessions.create(SessionId(`terminal-admission-${name}`), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const confine = vi.spyOn(ctx.sandbox, 'confine')
  const spawn = vi.spyOn(ctx.subprocess, 'spawnTerminal')
  const invoke = (tool: string, args: unknown) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: tool, arguments: args, agent, callId: ToolCallId(`terminal-${tool}`), signal: new AbortController().signal,
  }))
  const opened = await invoke('terminal_open', { type: 'shell', cwd: workspace, file_path: target })
  expect(confine).toHaveBeenCalledOnce()
  const confinement = confine.mock.results[0]
  if (confinement?.type !== 'return') throw new Error('Confinement did not return a result')
  const confined = await confinement.value
  expect(opened.isError, JSON.stringify(opened.content)).toBe(false)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: confined?.argv }))
  const terminal = ctx.terminals.list(agent)[0]
  if (terminal === undefined) throw new Error('Real terminal was not published')
  const result = await invoke('terminal_send', {
    sessionId: terminal.sessionId, text: `printf replacement > '${target}'`, file_path: target,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.content)).toMatch(/permission denied|read-only file system/i)
  expect(readFileSync(target, 'utf8')).toBe(original)
  expect((await invoke('terminal_close', { sessionId: terminal.sessionId })).isError).toBe(false)
  executed.add(`@panedesk/dsh-tool-terminal:${name}`)
})

it.each(['terminal_list', 'terminal_read', 'terminal_signal', 'terminal_close'])(
  '%s only observes or controls the calling session terminal', async (name) => {
    const { ctx, target, original, workspace } = await fixture()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(ToolTerminal)
    const agents: Agent[] = []
    for (const owner of ['caller', 'other']) {
      const session = ctx.sessions.create(SessionId(`terminal-${name}-${owner}`))
      const agent: Agent = {
        id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
        send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
        inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
        whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(agent)
      agents.push(agent)
    }
    const [caller, other] = agents
    if (caller === undefined || other === undefined) throw new Error('Missing terminal owners')
    const backends: TerminalBackendSession[] = []
    ctx.terminals.registerBackend({ type: 'admission', async spawn() {
      const backend: TerminalBackendSession = {
        motd: 'Read-only terminal fixture',
        startSend() { throw new Error('Control-only evidence must not send input') },
        read: vi.fn(() => ({ text: 'history', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false })),
        signal: vi.fn(async () => ({ delivered: true as const, targetPgid: 1 })),
        status: vi.fn(() => ({ kind: 'running' as const })),
        close: vi.fn(async () => {}),
      }
      backends.push(backend)
      return backend
    } })
    const owned = await ctx.terminals.spawn(caller, { type: 'admission', cwd: workspace })
    const foreign = await ctx.terminals.spawn(other, { type: 'admission', cwd: workspace })
    const foreignBackend = backends[1]
    if (foreignBackend === undefined) throw new Error('Missing foreign terminal')
    const foreignRead = vi.spyOn(foreignBackend, 'read')
    const foreignSignal = vi.spyOn(foreignBackend, 'signal')
    const foreignClose = vi.spyOn(foreignBackend, 'close')
    const invoke = (id: string) => ctx.tools.execute({
      name, arguments: { sessionId: id, signal: 'SIGINT', file_path: target, output: '../escape' },
      agent: caller, callId: ToolCallId(`terminal-control-${name}`), signal: new AbortController().signal,
    })
    const result = await invoke(owned.sessionId)
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (name === 'terminal_list') {
      expect(JSON.stringify(result.value)).toContain(owned.sessionId)
      expect(JSON.stringify(result.value)).not.toContain(foreign.sessionId)
    } else {
      expect((await invoke(foreign.sessionId)).isError).toBe(true)
    }
    expect(foreignRead).not.toHaveBeenCalled()
    expect(foreignSignal).not.toHaveBeenCalled()
    expect(foreignClose).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe(original)
    executed.add(`@panedesk/dsh-tool-terminal:${name}`)
  },
)

it.each([false, true])('list_subagent_models uses read-only catalog defaults (exact: %s)', async (exact) => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(LlmRuntime)
  class AdmissionCatalog extends LlmAdapter {
    stream(): AsyncIterable<StreamChunk> { throw new Error('Admission tests never request model output') }
  }
  const adapter = new AdmissionCatalog()
  const list = vi.spyOn(adapter, 'listModels')
  const resolve = vi.spyOn(adapter, 'resolveModel')
  const stream = vi.spyOn(adapter, 'stream')
  ctx.llm.registerAdapter(['admission'], adapter)
  registerListSubagentModels(ctx, { routes: [{ provider: 'admission', model: 'synthetic' }] })
  const result = await call('list_subagent_models', {
    provider: 'admission', ...exact ? { model: 'synthetic' } : {},
    file_path: target, content: 'replacement',
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.content)).toContain(exact ? 'admission/synthetic' : 'no advertised models for admission')
  if (exact) {
    expect(resolve).toHaveBeenCalledWith('admission', 'synthetic', expect.any(AbortSignal))
    expect(list).not.toHaveBeenCalled()
  } else {
    expect(list).toHaveBeenCalledWith('admission')
    expect(resolve).not.toHaveBeenCalled()
  }
  expect(stream).not.toHaveBeenCalled()
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-subagent:list_subagent_models')
})

it.each(['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read'])(
  '%s retains protected input bytes with the real SQLite and JSONL providers', async (name) => {
    const { ctx, root, workspace, target, original } = await fixture()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'session-logs'), compression: 'none' })
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query-index', 'sessions.db') })
    await ctx.plugin(ToolSessionQuery)
    const persisted = SessionId(`persisted-${name}`)
    const writer = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: persisted, createdAt: 1, cwd: workspace, isSeeded: false,
    })
    try {
      await writer.append([{
        type: 'user/message', seq: SessionSeq(0), time: 2, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'admissionneedle' }], source: { kind: 'user' } }),
      }])
    } finally { await writer.close() }
    const session = ctx.sessions.create(SessionId(`query-admission-${name}`), { meta: { cwd: workspace } })
    const agent: Agent = {
      id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
      send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const before = session.seq
    const args = name === 'session_search' ? { query: 'admissionneedle' }
      : name === 'session_event_search' ? { session_id: persisted, query: 'admissionneedle' }
        : name === 'session_trace' ? { session_id: persisted } : { session_id: persisted, seq: 0 }
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name, arguments: { ...args, file_path: target, content: 'model replacement', output: target },
      agent, callId: ToolCallId(`query-admission-${name}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(JSON.stringify(result.content)).toContain(persisted)
    expect(session.seq).toBe(before)
    expect(readFileSync(target, 'utf8')).toBe(original)
    executed.add(`@panedesk/dsh-tool-session-query:${name}`)
  },
)

it('todo_write retains protected input bytes while appending its domain event', async () => {
  const { ctx, root, target, original } = await fixture()
  const storageRoot = join(root, 'todo-sessions')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
  const session = ctx.sessions.create(SessionId('todo-admission'))
  const writer = await ctx.sessionPersistence.create(session.header)
  onTestFinished(() => writer.close())
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const before = session.seq
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'todo_write', arguments: { todos: [{ content: `Retain ${target}`, status: 'pending' }], file_path: target, content: 'replacement' },
    agent, callId: ToolCallId('todo-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(session.seq).toBe(before + 1)
  expect(result.value).toMatchObject({ todos: [{ content: `Retain ${target}`, status: 'pending' }] })
  const alias = join(root, 'todo-output-link')
  symlinkSync(dirname(target), alias, 'dir')
  for (const path of ['../protected-input', join(alias, 'cordis.patch.yml')]) {
    const changed = await ctx.tools.execute({
      name: 'todo_write', arguments: { todos: [{ content: path, status: 'pending' }], file_path: path, root: path },
      agent, callId: ToolCallId('todo-storage'), signal: new AbortController().signal,
    })
    expect(changed.isError, JSON.stringify(changed.content)).toBe(false)
  }
  await ctx.sessions.flush(session)
  const directory = await ctx.sessionPersistence.sidecarDirectory?.(session.id)
  if (directory === undefined) throw new Error('Todo session was not persisted')
  const suffix = relative(storageRoot, directory)
  expect(isAbsolute(suffix)).toBe(false)
  expect(suffix.split(/[\\/]/)).not.toContain('..')
  const persisted = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
  expect(persisted).toContain(JSON.stringify('../protected-input'))
  expect(persisted).toContain(JSON.stringify(join(alias, 'cordis.patch.yml')))
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-todo:todo_write')
})

it('working_directory retains protected input bytes while changing its domain state', async () => {
  const { ctx, root, workspace, target, original } = await fixture('native', true)
  const storageRoot = join(root, 'directory-storage')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  await ctx.plugin(ToolWorkingDirectory)
  const session = ctx.sessions.create(SessionId('directory-admission'), { meta: { cwd: workspace } })
  const writer = await ctx.sessionPersistence.create(session.header)
  onTestFinished(() => writer.close())
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const before = session.seq
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'working_directory', arguments: { cd: dirname(target), file_path: target, content: 'replacement' },
    agent, callId: ToolCallId('directory-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(ctx.workingDirectory.get(session)).toBe(dirname(target))
  expect(session.seq).toBe(before + 1)
  await ctx.sessions.flush(session)
  const directory = await ctx.sessionPersistence.sidecarDirectory?.(session.id)
  if (directory === undefined) throw new Error('Working-directory session was not persisted')
  const alias = join(workspace, 'directory-output-link')
  symlinkSync(dirname(target), alias, 'dir')
  for (const cd of [`${dirname(target)}/../test`, alias]) {
    const changed = await ctx.tools.execute({
      name: 'working_directory', arguments: { cd, file_path: target, root: cd }, agent,
      callId: ToolCallId('directory-storage'), signal: new AbortController().signal,
    })
    expect(changed.isError, JSON.stringify(changed.content)).toBe(false)
    await ctx.sessions.flush(session)
    expect(await ctx.sessionPersistence.sidecarDirectory?.(session.id)).toBe(directory)
  }
  const suffix = relative(storageRoot, directory)
  expect(isAbsolute(suffix)).toBe(false)
  expect(suffix.split(/[\\/]/)).not.toContain('..')
  expect(readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')).toContain(JSON.stringify(dirname(target)))
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-working-directory:working_directory')
})

it('lsp confines a real stdio server and retains protected inputs', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tool-lsp:lsp')
  const { ctx, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(Lsp)
  await ctx.plugin(ToolLsp)
  const server = `
    const fs = require('node:fs');
    let buffer = Buffer.alloc(0);
    let source;
    const reply = (id, result) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
      process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
    };
    process.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\\r\\n\\r\\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\\d+)/i.exec(buffer.toString('ascii', 0, end))[1]);
        if (buffer.length < end + 4 + length) return;
        const message = JSON.parse(buffer.toString('utf8', end + 4, end + 4 + length));
        buffer = buffer.subarray(end + 4 + length);
        if (message.method === 'initialize') reply(message.id, { capabilities: { textDocumentSync: 1, hoverProvider: true } });
        else if (message.method === 'textDocument/didOpen') source = new URL(message.params.textDocument.uri);
        else if (message.method === 'textDocument/hover') {
          let outcome = 'write succeeded';
          try { fs.writeFileSync(source, 'language server replacement\\n'); }
          catch (error) { outcome = error.code; }
          reply(message.id, { contents: outcome });
        } else if (message.method === 'shutdown') reply(message.id, null);
        else if (message.method === 'exit') process.exit(0);
      }
    });
  `
  await ctx.plugin(LspStdio, { servers: { admission: {
    command: process.execPath, args: ['-e', server], extensionToLanguage: { '.yml': 'yaml' },
    shutdownTimeoutMs: 200, killGraceMs: 200,
  } } })
  const confine = vi.spyOn(ctx.sandbox, 'confine')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const session = ctx.sessions.create(SessionId('lsp-admission'), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'lsp', arguments: { operation: 'hover', file_path: target, line: 1, character: 1 },
    agent, callId: ToolCallId('lsp-admission'), signal: new AbortController().signal,
  }))
  expect.soft(confine).toHaveBeenCalledOnce()
  expect.soft(result.isError, JSON.stringify(result.content)).toBe(false)
  expect.soft(JSON.stringify(result.content)).toMatch(/EACCES|EPERM|EROFS/)
  expect.soft(readFileSync(target, 'utf8')).toBe(original)
  const confinement = confine.mock.results[0]
  if (confinement?.type !== 'return') throw new Error('Confinement did not return a result')
  const confined = await confinement.value
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ argv: confined.argv }))
  executed.add('@panedesk/dsh-tool-lsp:lsp')
})

// The tool keeps its 5s deadline; allow dispatch and teardown to report its result first.
it.for(['bash', 'pwsh'] as const)('%s persistent executes through the real terminal backend', { timeout: 15_000 }, async (name, test) => {
  nativeEvidence(test, `@panedesk/dsh-tool-${name}-persistent:${name}`)
  const { ctx, workspace } = await fixture()
  let terminalContent = 'The tool did not return before the test finished.'
  onTestFailed(() => { console.error(`Persistent ${name} terminal result: ${terminalContent}`) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(TerminalBash, { shellDialect: name, timeoutMs: 5000 })
  if (name === 'bash') await ctx.plugin(PersistentBash, { timeoutMs: 5000 })
  else await ctx.plugin(PersistentPwsh, { timeoutMs: 5000 })
  const session = ctx.sessions.create(SessionId(`persistent-admission-${name}`), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: { command: name === 'bash' ? 'printf terminal-ready' : "Write-Output 'terminal-ready'" }, agent,
    callId: ToolCallId(`persistent-admission-${name}`), signal: new AbortController().signal,
  }))
  terminalContent = JSON.stringify(result.content)
  if (name === 'pwsh') {
    // The native sandbox can hide persistent PowerShell output, including its prompt.
    expect(terminalContent).toMatch(/terminal-ready|\[exit code: -?\d+\]|PERSISTENT_PWSH_TIMEOUT/)
  } else {
    expect(result.isError, terminalContent).toBe(false)
    expect(terminalContent).toContain('terminal-ready')
  }
  executed.add(`@panedesk/dsh-tool-${name}-persistent:${name}`)
})

it('present retains protected input bytes while declaring a real delivery', async () => {
  const { ctx, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
  await ctx.plugin(ToolPresent)
  const session = ctx.sessions.create(SessionId('present-admission'), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'present', arguments: { files: [{ path: target, description: 'Protected input' }] },
    agent, callId: ToolCallId('present-admission'), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ files: [{ path: target, description: 'Protected input' }] })
  expect(session.snapshotEvents().find(event => event.type === 'deliverables/presented')?.data.files)
    .toEqual([{ path: target, description: 'Protected input' }])
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-present:present')
})

it('exit_plan_mode delegates review without a model-controlled write destination', async () => {
  const { ctx, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.effect(() => ctx.sessionProjections.register(turnBoundaryProjectionDefinition))
  await ctx.plugin(UserQuestions)
  await ctx.plugin(PlanModeController, { section: 'Plan before changing files.' })
  const session = ctx.sessions.create(SessionId('plan-admission'))
  const agent: Agent = {
    id: session.id, session, options: {}, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('plan/mode', { active: true })
  const plan = `# Preserve inputs\n\nKeep ${target} unchanged.`
  let reviews = 0
  ctx.on('user-questions/request', (request) => {
    reviews += 1
    expect(request.agent).toBe(agent)
    expect(request.questions).toHaveLength(1)
    expect(request.questions[0]).toMatchObject({ detail: plan, intent: { kind: 'plan-review', approve: 'Approve' } })
    expect(request.questions[0]).not.toHaveProperty('file_path')
    return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['Approve'] })) })
  })
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: 'exit_plan_mode', arguments: { plan, file_path: target, content: 'replacement' },
    agent, callId: ToolCallId('plan-admission'), signal: new AbortController().signal,
  }))
  expect(result).toMatchObject({ isError: false, value: { approved: true } })
  expect(reviews).toBe(1)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-plan-mode:exit_plan_mode')
})

it('read_image stores attachments only under the configured application root', async () => {
  const { ctx, root, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'attachments-home') })
  await ctx.plugin(LlmRuntime)
  class ImageCatalog extends LlmAdapter {
    override resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
    }
    stream(): AsyncIterable<StreamChunk> { throw new Error('Admission tests never request model output') }
  }
  ctx.llm.registerAdapter(['admission-image'], new ImageCatalog())
  const imagePath = join(workspace, 'input.png')
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
  const session = ctx.sessions.create(SessionId('image-admission'), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, session, options: { provider: 'admission-image', model: 'synthetic' }, inbox: createInboxStub(), status: 'running', ctx,
    send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const alias = join(workspace, 'image-link.png')
  symlinkSync(imagePath, alias)
  mkdirSync(join(workspace, 'nested'))
  const save = vi.spyOn(ctx.attachments, 'saveImage')
  let storedPath: string | undefined
  for (const path of [imagePath, `${workspace}/nested/../input.png`, alias]) {
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name: 'read_image', arguments: { file_path: path, output: target, output_path: '../escape', content: 'replacement' }, agent,
      callId: ToolCallId('image-admission'), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const saving = save.mock.results.at(-1)
    if (saving?.type !== 'return') throw new Error('Attachment save did not return a result')
    const saved = await saving.value
    expect(saved).toBeDefined()
    if (saved === undefined) throw new Error('Attachment provider did not return a reference')
    const destination = ctx.attachments.imageHostPath(saved)
    if (destination === undefined) throw new Error('Local attachment provider did not return a host path')
    const digest = String(saved.attachmentId).replace('sha256:', '')
    expect(destination).toBe(join(root, 'attachments-home', 'attachments', 'v1', 'objects', digest.slice(0, 2), digest))
    if (storedPath !== undefined) expect(destination).toBe(storedPath)
    storedPath = destination
    expect(readFileSync(destination).byteLength).toBe(saved.bytes)
    expect(save.mock.calls.at(-1)?.[0]).not.toHaveProperty('output_path')
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  expect(save).toHaveBeenCalledTimes(3)
  executed.add('@panedesk/dsh-tool-fs:read_image')
})

it.each([
  ['stagehand_act', { instruction: 'Retain the protected input' }],
  ['stagehand_extract', { instruction: 'Read the protected input' }],
  ['stagehand_navigate', { url: 'https://example.invalid/' }],
  ['stagehand_observe', { instruction: 'Locate the protected input' }],
  ['stagehand_screenshot', {}],
  ['stagehand_tabs', { action: 'list' }],
] as const)('%s denies a caller without live identity before browser acquisition', async (name, args) => {
  const { ctx, target, original, call } = await fixture()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(BrowserUseRegistry)
  await ctx.plugin(Stagehand, {
    mode: 'launch', model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture-model-key' },
  })
  const result = await call(name, args)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('require an exact live Agent')
  expect(readFileSync(target, 'utf8')).toBe(original)
})

it('plugin_market reads its HTTP index without a model-controlled write destination', async () => {
  const home = mkdtempSync(join(tmpdir(), 'market-admission-'))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"admission-installation","dependencies":{}}\n')
  initProfile(dir, [])
  const target = join(dir, 'cordis.patch.yml')
  const original = '[{"insert":[{"id":"manager","name":"cordis:manager"}]}]\n'
  writeFileSync(target, original)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, home, patchPath: target, cwd: home, installAnchor: anchor,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  let owner: Context | undefined
  onTestFinished(async () => {
    vi.unstubAllGlobals()
    await owner?.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    provideWorkingDirectoryFixture(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
    ctx.plugin(SessionProjectionRegistry)
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
  })
  const url = 'https://market.example/index.json'
  await ctx.plugin(PluginMarket, { indexes: [url] })
  await ctx.plugin(MarketTool)
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify({ format: 1, title: 'Admission market', plugins: [] })))
  vi.stubGlobal('fetch', fetch)
  const result = await ctx.tools.execute({
    name: 'plugin_market', arguments: { action: 'list_plugins', target: url, file_path: target, content: 'replacement' },
    callId: ToolCallId('market-admission'), signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.content)).toContain('Admission market')
  expect(fetch).toHaveBeenCalledOnce()
  const request = fetch.mock.calls[0]
  expect(request?.[0]).toBe(url)
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
  expect(request?.[1]).toEqual({
    signal: request?.[1]?.signal, redirect: 'error', headers: { accept: 'application/json' },
  })
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-plugin-market:plugin_market')
})

it.each(['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'] as const)('%s keeps team task state under the configured session root', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  const storageRoot = join(root, 'task-sessions')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TeamService)
  await ctx.plugin(ToolTeam)
  const alias = join(workspace, 'task-link')
  symlinkSync(dirname(target), alias)
  const paths = [target, '../protected-input', join(alias, 'cordis.patch.yml')]
  for (const [index, path] of paths.entries()) {
    const agent = await ctx.agentLoop.create(SessionId(`task-storage-${name}-${index}`), {}, { cwd: workspace })
    await ctx.sessions.flush(agent.session)
    const directory = await ctx.sessionPersistence.sidecarDirectory?.(agent.session.id)
    if (directory === undefined) throw new Error('Missing task session directory')
    const task = name === 'team_task_create' ? undefined
      : await ctx.agentTeams.createTask(agent, { subject: 'Retain input', description: path })
    const args = name === 'team_task_create' ? { subject: 'Retain input', description: path }
      : name === 'team_task_update' ? { task_id: task?.id, expected_revision: task?.revision, action: 'edit', description: path }
        : name === 'team_task_get' ? { task_id: task?.id } : {}
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name, arguments: { ...args, root: path, file_path: path, output_path: path }, agent,
      callId: ToolCallId(`task-storage-${name}-${index}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    await ctx.sessions.flush(agent.session)
    expect(await ctx.sessionPersistence.sidecarDirectory?.(agent.session.id)).toBe(directory)
    const suffix = relative(storageRoot, directory)
    expect(isAbsolute(suffix)).toBe(false)
    expect(suffix.split(/[\\/]/)).not.toContain('..')
    const log = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
    expect(log).toContain('team/task')
    expect(log).toContain(JSON.stringify(path))
    expect(log).not.toContain('"type":"turn/start"')
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  executed.add(`@panedesk/dsh-experimental-tool-agent-team:${name}`)
})

it.each(['list_agents', 'wait_agent'] as const)('%s observes team state without appending events or starting processes', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'observed-team'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'observed-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TeamService)
  await ctx.plugin(ToolTeam)
  const agent = await ctx.agentLoop.create(SessionId(`team-observe-${name}`), {}, { cwd: workspace })
  await ctx.sessions.flush(agent.session)
  const before = agent.session.seq
  const link = join(workspace, 'team-observation-link')
  symlinkSync(dirname(target), link, 'dir')
  for (const path of [target, '../protected-input', join(link, 'cordis.patch.yml')]) {
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name, arguments: { timeout_ms: 10000, root: path, file_path: path, output_path: path, content: 'replacement' },
      agent, callId: ToolCallId(`team-observe-${name}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (name === 'list_agents') expect(result.value).toContainEqual(expect.objectContaining({ target: 'lead' }))
    else expect(result.value).toMatchObject({ noProgress: { reason: 'no-active-peer' } })
    expect(agent.session.seq).toBe(before)
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  executed.add(`@panedesk/dsh-experimental-tool-agent-team:${name}`)
})

it.each(['spawn_teammate', 'subagent'] as const)('%s creates application sessions without model-controlled storage paths', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture('native', true)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  const prepareCall = vi.spyOn(ctx.llm, 'prepareCall')
  const storage = join(root, 'delegated-sessions')
  await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'delegated-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const prepareContinuable = vi.fn(() => Promise.resolve({}))
  ctx.subagents.registerProvider({
    name: 'admission-local', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    prepareContinuable,
  })
  if (name === 'spawn_teammate') {
    await ctx.plugin(TeamService)
    await ctx.plugin(ToolTeam, { freshProvider: 'admission-local' })
  } else await ctx.plugin(ToolSubagent, { provider: 'admission-local' })
  const agent = await ctx.agentLoop.create(SessionId(`delegated-storage-${name}`), {}, { cwd: workspace })
  const link = join(workspace, 'delegation-link')
  symlinkSync(dirname(target), link, 'dir')
  for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name, arguments: { name: `worker-${index}`, description: 'Retain input', prompt: path,
        root: path, file_path: path, output_path: path },
      agent, callId: ToolCallId(`delegated-storage-${index}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(name === 'spawn_teammate')
    // Without a model route the inbox is durable, but no user message is admitted to a model step.
    if (name === 'spawn_teammate') expect(JSON.stringify(result.content)).toContain('initial prompt was not durably accepted')
    const value: unknown = result.value
    const childId = name === 'spawn_teammate'
      ? ctx.agentTeams.listMembers(agent).find(member => member.name === `worker-${index}`)?.id
      : typeof value === 'object' && value !== null && 'subagentId' in value && typeof value.subagentId === 'string'
        ? value.subagentId : undefined
    if (childId === undefined) throw new Error('Missing delegated Session identity')
    await ctx.subagents.waitForChildren(agent)
    await agent.whenIdle()
    const id = SessionId(childId)
    const directory = await ctx.sessionPersistence.sidecarDirectory?.(id)
    if (directory === undefined) throw new Error('Missing delegated Session directory')
    expect(isAbsolute(relative(storage, directory))).toBe(false)
    expect(relative(storage, directory).startsWith('..')).toBe(false)
    await using persisted = await ctx.sessionPersistence.open(id, 'read')
    const { events } = await persisted.read()
    expect(JSON.stringify(events)).toContain(JSON.stringify(path))
    expect(events.some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  expect(prepareContinuable).toHaveBeenCalledTimes(3)
  expect(prepareCall).not.toHaveBeenCalled()
  executed.add(name === 'spawn_teammate'
    ? '@panedesk/dsh-experimental-tool-agent-team:spawn_teammate' : '@panedesk/dsh-tool-subagent:subagent')
})

it.each([
  ['send_message', 'team'], ['interrupt_agent', 'team'],
  ['send_message', 'subagent'], ['interrupt_agent', 'subagent'], ['list_agents', 'subagent'],
] as const)('%s controls %s children with application-owned storage', async (name, kind) => {
  const { ctx, root, workspace, target, original } = await fixture('native', true)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  const prepareCall = vi.spyOn(ctx.llm, 'prepareCall')
  const storage = join(root, 'controlled-team')
  await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'controlled-team.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({ name: 'controlled-team', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    prepareContinuable: () => Promise.resolve({}) })
  await ctx.plugin(TeamService)
  const teamTools = await ctx.plugin(ToolTeam, { freshProvider: 'controlled-team' })
  const lead = await ctx.agentLoop.create(SessionId(`controlled-team-${name}`), {}, { cwd: workspace })
  const holds = new Map<SessionId, { agent: Agent; signal: AbortSignal; release: () => void; done: Promise<void> }>()
  const admissions: Promise<void>[] = []
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== lead.id) return
    const admission = agent.whenIdle().then(() => {
      const release = Promise.withResolvers<undefined>()
      let maintenanceSignal: AbortSignal | undefined
      const done = agent.runMaintenance((signal) => { maintenanceSignal = signal; return release.promise })
      if (maintenanceSignal === undefined) throw new Error('Maintenance did not claim the child')
      holds.set(agent.id, { agent, signal: maintenanceSignal, release: () => { release.resolve(undefined) }, done })
    })
    admissions.push(admission)
  })
  onTestFinished(async () => {
    await Promise.all(admissions)
    for (const hold of holds.values()) {
      hold.agent.cancel({ kind: 'disposed' })
      hold.release()
    }
    await Promise.all([...holds.values()].map(hold => hold.done))
    expect(prepareCall).not.toHaveBeenCalled()
    for (const hold of holds.values()) {
      expect(hold.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    }
  })
  for (const worker of ['worker-a', 'worker-b']) {
    const created = await ctx.agents.withInitiator(lead, () => ctx.tools.execute({
      name: 'spawn_teammate', arguments: { name: worker, description: 'Retain input', prompt: 'Wait for the owner.' },
      agent: lead, callId: ToolCallId(`controlled-spawn-${worker}`), signal: new AbortController().signal,
    }))
    expect(created.isError, JSON.stringify(created.content)).toBe(false)
  }
  const members = ctx.agentTeams.listMembers(lead)
  const first = members.find(member => member.name === 'worker-a')
  const second = members.find(member => member.name === 'worker-b')
  if (first === undefined || second === undefined) throw new Error('Missing real team members')
  const selected = holds.get(first.id)
  const untouched = holds.get(second.id)
  if (selected === undefined || untouched === undefined) throw new Error('Missing real child maintenance')
  if (kind === 'subagent') {
    await teamTools.dispose()
    if (name === 'list_agents') await ctx.plugin(SubagentList)
    else await ctx.plugin(SubagentControl)
  }
  if (name === 'list_agents') {
    await ctx.sessions.flush(lead.session)
    for (const hold of holds.values()) await ctx.sessions.flush(hold.agent.session)
    const before = lead.session.seq
    const observeFiles = () => readdirSync(storage, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => ({ path: join(entry.parentPath, entry.name),
        bytes: readFileSync(join(entry.parentPath, entry.name)).toString('base64') })).sort((a, b) => a.path.localeCompare(b.path))
    const files = observeFiles()
    const cold = new Context()
    onTestFinished(() => cold.fiber.dispose())
    await cold.plugin(SessionStore)
    await cold.plugin(SessionProjectionRegistry)
    await cold.plugin(AgentRegistry)
    provideWorkingDirectoryFixture(cold)
    await cold.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
    await cold.plugin(SqliteSessionQueryEngine, { path: join(root, 'cold-child-index.sqlite'), openAt: 'never' })
    await cold.plugin(SubagentRuntime)
    const link = join(workspace, 'child-list-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      for (const scope of ['children', 'descendants']) {
        const result = await ctx.agents.withInitiator(lead, () => ctx.tools.execute({
          name, arguments: { scope, root: path, file_path: path, output_path: path, content: 'replacement' },
          agent: lead, callId: ToolCallId(`child-list-${scope}-${index}`), signal: new AbortController().signal,
        }))
        expect(result.isError, JSON.stringify(result.content)).toBe(false)
        expect(result.value).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id }),
        ]))
        expect(lead.session.seq).toBe(before)
        expect(observeFiles()).toEqual(files)
        const children = scope === 'children' ? await cold.subagents.listChildren(lead.id)
          : await cold.subagents.listDescendants(lead.id)
        expect(children).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id }),
        ]))
        expect(cold.sessions.list()).toHaveLength(0)
        expect(cold.agents.list()).toHaveLength(0)
        expect(observeFiles()).toEqual(files)
        expect(readFileSync(target, 'utf8')).toBe(original)
      }
    }
    expect(prepareCall).not.toHaveBeenCalled()
    executed.add('@panedesk/dsh-tool-subagent-control:list_agents')
    return
  }
  const outsider = await ctx.agentLoop.create(SessionId(`unrelated-${kind}-${name}`), {}, { cwd: workspace })
  const denied = await ctx.agents.withInitiator(outsider, () => ctx.tools.execute({
    name, arguments: { target: 'worker-a', agent_id: first.id, message: target, file_path: target },
    agent: outsider, callId: ToolCallId('unrelated-child-control'), signal: new AbortController().signal,
  }))
  expect(denied.isError).toBe(true)
  expect(selected.signal.aborted).toBe(false)
  expect(untouched.signal.aborted).toBe(false)
  expect(JSON.stringify([...selected.agent.inbox.nextTurn, ...selected.agent.inbox.nextStep])).not.toContain(target)
  const link = join(workspace, 'controlled-team-link')
  symlinkSync(dirname(target), link, 'dir')
  for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
    const before = [...selected.agent.inbox.nextTurn, ...selected.agent.inbox.nextStep].map(input => input.id)
    const result = await ctx.agents.withInitiator(lead, () => ctx.tools.execute({
      name, arguments: { target: 'worker-a', agent_id: first.id, message: path, root: path, file_path: path, output_path: path },
      agent: lead, callId: ToolCallId(`controlled-team-${index}`), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (kind === 'subagent' && name === 'send_message') {
      const value: unknown = result.value
      if (typeof value !== 'object' || value === null || !('messageId' in value)) throw new Error('Missing message identity')
      expect(typeof value.messageId).toBe('string')
    } else expect(result.value).toMatchObject(kind === 'team'
      ? name === 'send_message' ? { sent: true } : { previousStatus: 'inactive' }
      : { accepted: true })
    expect(untouched.signal.aborted).toBe(false)
    if (name === 'interrupt_agent') {
      expect(selected.signal.aborted).toBe(true)
      expect([...selected.agent.inbox.nextTurn, ...selected.agent.inbox.nextStep].map(input => input.id)).toEqual(before)
    }
    await ctx.sessions.flush(selected.agent.session)
    const directory = await ctx.sessionPersistence.sidecarDirectory?.(selected.agent.id)
    if (directory === undefined) throw new Error('Missing controlled team storage')
    expect(relative(storage, directory).split(/[\\/]/)).not.toContain('..')
    const log = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
    expect(log).toContain('agent/inbox/spliced')
    if (name === 'send_message') expect(log).toContain(JSON.stringify(path).slice(1, -1))
    expect(log).not.toContain('"type":"turn/start"')
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  expect(prepareCall).not.toHaveBeenCalled()
  executed.add(kind === 'team' ? `@panedesk/dsh-experimental-tool-agent-team:${name}` : `@panedesk/dsh-tool-subagent-control:${name}`)
})

it.each([
  'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
] as const)('%s executes through the real Team service without model output', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'team-sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'team-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TeamService)
  await ctx.plugin(ToolTeam, { freshProvider: 'admission-team' })
  ctx.subagents.registerProvider({
    name: 'admission-team', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    prepareContinuable: () => Promise.resolve({}),
  })
  const agent = await ctx.agentLoop.create(SessionId(`team-admission-${name}`), {}, { cwd: workspace })
  let task
  if (name === 'team_task_get' || name === 'team_task_update') {
    task = await ctx.agentTeams.createTask(agent, { subject: 'Retain input', description: 'Keep protected bytes unchanged.' })
  }
  const args = name === 'send_message' ? { target: 'missing-worker', message: `Keep ${target} unchanged.` }
    : name === 'interrupt_agent' ? { target: 'missing-worker' }
      : name === 'wait_agent' ? { timeout_ms: 10000 }
        : name === 'team_task_create' ? { subject: 'Retain input', description: `Keep ${target} unchanged.` }
          : name === 'team_task_get' ? { task_id: task?.id }
            : name === 'team_task_update' ? { task_id: task?.id, expected_revision: task?.revision, action: 'claim' }
              : {}
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: args, agent, callId: ToolCallId(`team-admission-${name}`), signal: new AbortController().signal,
  }))
  if (name === 'send_message' || name === 'interrupt_agent') {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
  } else {
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (name === 'list_agents') expect(result.value).toContainEqual(expect.objectContaining({ target: 'lead' }))
    if (name === 'wait_agent') expect(result.value).toMatchObject({ noProgress: { reason: 'no-active-peer' } })
    if (name === 'team_task_create') expect(ctx.agentTeams.listTasks(agent)).toHaveLength(1)
    if (name === 'team_task_get') expect(result.value).toMatchObject({ id: task?.id, revision: 1 })
    if (name === 'team_task_list') expect(result.value).toMatchObject({ tasks: [] })
    if (name === 'team_task_update') expect(result.value).toMatchObject({ id: task?.id, revision: 2, status: 'in_progress' })
  }
  expect(readFileSync(target, 'utf8')).toBe(original)
})

it.each(['send_message', 'interrupt_agent', 'list_agents'] as const)('%s executes through the real subagent runtime without model output', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'subagent-sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'subagent-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  if (name === 'list_agents') await ctx.plugin(SubagentList)
  else await ctx.plugin(SubagentControl)
  const agent = await ctx.agentLoop.create(SessionId(`subagent-admission-${name}`), {}, { cwd: workspace })
  const args = name === 'send_message' ? { agent_id: 'missing-child', message: `Keep ${target} unchanged.` }
    : name === 'interrupt_agent' ? { agent_id: 'missing-child' } : {}
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: args, agent, callId: ToolCallId(`subagent-admission-${name}`), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(name === 'send_message')
  if (name === 'list_agents') expect(result.value).toEqual([])
  if (name === 'interrupt_agent') expect(result.value).toEqual({ accepted: true })
  expect(readFileSync(target, 'utf8')).toBe(original)
})

// Three real checkouts each run eight confined subprocesses; the per-command budget is 10s.
it('create_worktree confines commands for a live caller', { timeout: 40_000 }, async (test) => {
  nativeEvidence(test, '@panedesk/dsh-experimental-tool-worktree:create_worktree')
  const { ctx, root, workspace, target } = await fixture('native', true, true)
  const repository = join(workspace, 'repository')
  mkdirSync(repository, { recursive: true })
  const exec = promisify(execFile)
  const git = (...args: string[]) => exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Worktree Fixture', '-c', 'user.email=worktree-fixture@example.invalid', ...args,
  ], {
    cwd: repository,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0',
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  })
  await git('init', '-b', 'main')
  writeFileSync(join(repository, 'retained.txt'), 'committed input\n')
  await git('add', '--', 'retained.txt')
  await git('commit', '-m', 'Initialize isolated worktree fixture')
  const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'worktree-sessions'), compression: 'none' })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: repository })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(WorktreeService, { timeoutMs: 10000, graceMs: 200 })
  await ctx.plugin(ToolWorktree)
  const agent = await ctx.agentLoop.create(SessionId('worktree-admission'), {}, { cwd: repository })
  const link = join(repository, 'protected-link')
  symlinkSync(dirname(target), link, 'dir')
  for (const [index, path] of [target, '../../protected-input', join(link, 'cordis.patch.yml')].entries()) {
    await ctx.workingDirectory.set(agent, repository)
    const name = `isolated-checkout-${index}`
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name: 'create_worktree', arguments: { name, from: baseCommit, root: path, file_path: path, output_path: path },
      agent, callId: ToolCallId(name), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const destination = join(repository, '.agents', 'worktrees', name)
    expect(result.value).toEqual({ path: destination, branch: name, baseCommit, repositoryRoot: repository })
    expect(ctx.workingDirectory.get(agent.session)).toBe(destination)
    expect(readFileSync(join(destination, 'retained.txt'), 'utf8')).toBe('committed input\n')
  }
  executed.add('@panedesk/dsh-experimental-tool-worktree:create_worktree')
})

it('pwsh denies a protected input through the real local process sandbox', async (test) => {
  nativeEvidence(test, '@panedesk/dsh-tool-pwsh:pwsh')
  const { ctx, workspace, target, original, call } = await fixture()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(PwshExecutor, { cwd: workspace, timeoutMs: 10000, graceMs: 200 })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolPwsh)
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
  const allowed = join(workspace, 'permitted-pwsh.txt')
  const control = await call('pwsh', { command: `Set-Content -LiteralPath ${quote(allowed)} -Value allowed -NoNewline`, description: 'Write a workspace control' })
  expect(control.isError, JSON.stringify(control.content)).toBe(false)
  expect(readFileSync(allowed, 'utf8')).toBe('allowed')
  const result = await call('pwsh', { command: `Set-Content -LiteralPath ${quote(target)} -Value replacement`, description: 'Attempt protected input replacement' })
  expect(JSON.stringify(result.content)).toMatch(/denied|read-only|protected/i)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add('@panedesk/dsh-tool-pwsh:pwsh')
})

it.for(['workflow', 'ralph'] as const)('%s retains protected inputs through the real PTC workflow engine', async (name, test) => {
  nativeEvidence(test, `@panedesk/dsh-tool-${name}:${name}`)
  const { ctx, root, workspace, target, original } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'workflow-sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const disposeChild = vi.fn(async () => {})
  // A child-level failure settles normally; rejecting start would test an infrastructure fault.
  const startChild = vi.fn(async (): Promise<SubagentRun> => ({
    id: SessionId(`synthetic-workflow-child-${name}`),
    result: Promise.resolve({ output: [], stopReason: 'error' }),
    dispose: disposeChild,
  }))
  ctx.subagents.registerProvider({
    name: 'admission-workflow', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: startChild,
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(NodeRuntime, { timeoutMs: 10000, graceMs: 200 })
  await ctx.plugin(WorkflowPtc, { provider: 'admission-workflow' })
  if (name === 'workflow') await ctx.plugin(ToolWorkflow)
  else await ctx.plugin(ToolRalph, { subagentProvider: 'admission-workflow', maxRounds: 1 })
  const agent = await ctx.agentLoop.create(SessionId(`workflow-admission-${name}`), {}, { cwd: workspace })
  const confine = vi.spyOn(ctx.sandbox, 'confine')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const args = name === 'workflow' ? {
    script: 'return { filesystem: typeof process, target: args.target }',
    meta: { name: 'protected-input-check', description: 'Retain protected input' }, args: { target },
  } : { objective: `Keep ${target} unchanged.`, maxRounds: 1 }
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: args, agent, callId: ToolCallId(`workflow-admission-${name}`), signal: new AbortController().signal,
  }))
  expect(confine).toHaveBeenCalled()
  for (const [, policy] of confine.mock.calls) {
    expect(policy.mode).toBe('workspace-write')
    expect(policy.protectedPaths).toContain(dirname(target))
  }
  expect(readFileSync(target, 'utf8')).toBe(original)
  if (name === 'workflow') expect(result.isError, JSON.stringify(result.content)).toBe(false)
  else {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('child failed')
    expect(startChild).toHaveBeenCalledOnce()
    expect(disposeChild).toHaveBeenCalled()
  }
  expect(spawn).toHaveBeenCalled()
  expect(spawn.mock.calls).toHaveLength(confine.mock.results.length)
  for (const [index, confined] of confine.mock.results.entries()) {
    if (confined.type !== 'return') throw new Error('Workflow confinement did not return')
    expect(spawn.mock.calls[index]?.[0].argv).toEqual((await confined.value).argv)
  }
  executed.add(`@panedesk/dsh-tool-${name}:${name}`)
})

it.each([
  'seat_windows', 'seat_open', 'seat_renew', 'seat_replace', 'seat_close', 'seat_rename',
  'seat_wake', 'seat_wait', 'seat_cancel_wait', 'seat_report', 'seat_revoke_report',
  'seat_send', 'seat_list_online',
] as const)('%s executes with real local seat storage without starting a model', async (name) => {
  const { ctx, root, target, original, call } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'seat-sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'seat-storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionLedger, { dshHome: join(root, 'seat-ledger') })
  const nodeId = await ctx.sessionLedger.nodeId()
  if (name === 'seat_list_online') {
    await ctx.plugin(SeatEngine, {
      home: join(root, 'seat-engine'), nodeName: 'admission-node', nodeAliases: {},
      dedupWindowMs: 1000, maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8,
      budgetTimeZone: 'UTC', callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000,
      callbackRetryInitialMs: 1, callbackRetryMaxMs: 100, ownerObserveIntervalMs: 1000,
      ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000,
    })
    await expect.poll(() => ctx.get('seatEngine') !== undefined).toBe(true)
    await ctx.get('seatEngine')!.ready()
  }
  await ctx.plugin(SeatLocal, {
    directory: join(root, 'seat-catalog'), nodeId, nodeName: 'admission-node',
    nodeAliases: {}, defaults: {}, maxSourceBytes: 65536, maxPlans: 10, maxOpeningBytes: 65536,
    maxBatchSeats: 10, pageSize: 10, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed',
  })
  await expect.poll(() => ctx.get('seatLocalRead') !== undefined).toBe(true)
  if (name === 'seat_send' || name === 'seat_list_online') {
    await ctx.plugin(MessageDelivery, {
      dshHome: join(root, 'seat-mailbox'), nodeId: 'admission-node', maxRecordBytes: 1048576,
      maxContentBytes: 65536, maxBatchSize: 100, scanIntervalMs: 1000,
      lockTimeoutMs: 5000, lockRetryMs: 1, watch: false, seatAddressing: true,
    })
    await ctx.plugin(ToolSeatMessages)
  } else await ctx.plugin(ToolSeat)
  const args = name === 'seat_open' || name === 'seat_wake' ? { seat: 'protected-input-check' }
    : name === 'seat_send' ? { seat: 'protected-input-check', text: `Keep ${target} unchanged.` }
      : name === 'seat_wait' ? { mode: 'any', objects: [{ kind: 'job', id: 'admission-job' }] }
        : name === 'seat_cancel_wait' ? { waitId: 'admission-wait', expectedStateVersion: 0 }
          : name === 'seat_report' ? { canClose: true, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, stateVersion: 0 }
            : name === 'seat_revoke_report' ? { reportId: 'admission-report', expectedStateVersion: 0 }
              : name === 'seat_windows' || name === 'seat_list_online' ? {}
                : { sessionId: 'admission-window', expectedStateVersion: 0, title: 'Protected input check' }
  const result = await call(name, args)
  if (name === 'seat_windows' || name === 'seat_list_online') {
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (name === 'seat_windows') expect(JSON.stringify(result.content)).toContain('unavailable')
    else expect(JSON.stringify(result.content)).toContain('[]')
  } else {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/unavailable|calling Session/)
  }
  expect(readFileSync(target, 'utf8')).toBe(original)
})

it.each(([
  'seat_directories', 'seat_read', 'seat_write', 'seat_edit', 'seat_rename', 'seat_report', 'seat_revoke_report',
  'seat_wait', 'seat_cancel_wait', 'seat_send', 'seat_close', 'seat_wake', 'seat_windows', 'seat_list_online', 'seat_open', 'seat_replace',
] as const).flatMap(name => (name === 'seat_replace' ? [0, 1, 2] : [0]).map(pathIndex => [name, pathIndex] as const)))('%s protects profile inputs for a real prefilled seat window', async (name, pathIndex) => {
  const { ctx, root, workspace, target, original } = await fixture('native', true)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'directory-sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'directory-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(BashExecutor, { cwd: workspace, timeoutMs: 10000, graceMs: 200 })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(PermissionPresets, {
    defaultPreset: 'workspace-write', presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(DefaultModel, { provider: 'admission-seat', model: 'synthetic' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'directory-home') })
  await ctx.plugin(LocalCredentials, { path: join(root, 'directory-home', 'credentials.yaml'), dshHome: join(root, 'directory-home'), watch: false })
  await ctx.plugin(Connection, {})
  await ctx.plugin(Commands)
  await ctx.plugin(FileUploads)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionController, { nativeOpen: false })
  await ctx.plugin(SessionTitle, {
    fallbackMaxWords: 5, fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  await ctx.plugin(InstructionSubscriptions, { maxBytes: 65536, watch: false })
  let modelRequested = false
  let catalogAvailable = true
  class SeatCatalog extends LlmAdapter {
    override listModels(provider: string) { return Promise.resolve(catalogAvailable ? [{ provider, id: 'synthetic', name: 'Synthetic' }] : []) }
    override resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model,
        reasoning: { efforts: [{ id: ReasoningEffortId('admission-effort'), name: 'Admission' }],
          defaultEffort: ReasoningEffortId('admission-effort') } })
    }
    stream(): AsyncIterable<StreamChunk> {
      modelRequested = true
      throw new Error('Prefilled seat admission must not request model output')
    }
  }
  ctx.llm.registerAdapter(['admission-seat'], new SeatCatalog())
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'directory-storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionLedger, { dshHome: join(root, 'directory-ledger') })
  const nodeId = await ctx.sessionLedger.nodeId()
  await ctx.plugin(MessageDelivery, {
    dshHome: join(root, 'directory-mailbox'), nodeId, seatAddressing: true, maxRecordBytes: 1048576,
    maxContentBytes: 65536, maxBatchSize: 100, scanIntervalMs: 1000,
    lockTimeoutMs: 5000, lockRetryMs: 1, watch: false,
  })
  await ctx.plugin(SeatEngine, {
    home: join(root, 'directory-engine'), nodeName: 'admission-node', nodeAliases: { 'admission-node': nodeId },
    dedupWindowMs: 1000, maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8,
    budgetTimeZone: 'UTC', callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 100, ownerObserveIntervalMs: 1000,
    ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000,
  })
  await expect.poll(() => ctx.get('seatEngine') !== undefined).toBe(true)
  await ctx.get('seatEngine')!.ready()
  await ctx.plugin(SeatLocal, {
    directory: join(root, 'directory-catalog'), nodeId, nodeName: 'admission-node', nodeAliases: { 'admission-node': nodeId }, defaults: {},
    maxSourceBytes: 65536, maxPlans: 10, maxOpeningBytes: 65536, maxBatchSeats: 10, pageSize: 10,
    transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed',
  })
  await expect.poll(() => ctx.get('seatDirectories') !== undefined).toBe(true)
  await ctx.plugin(ToolSeat)
  const seats = ctx.get('seats')!.withAuthority({
    principalId: 'admission-owner' as SeatPrincipalId, origin: 'manual', nodeId,
  })
  expect(await seats.setAuthority({ authority: 'seat-store', authorizationRef: 'admission-owner' as AuthorizationRef,
    expectedRevision: 0, operationId: 'admission-authorize' as SeatOperationId })).toMatchObject({ status: 'saved' })
  const definition: SeatDefinition = {
    schemaVersion: 1, revision: 1, seat: 'admission-seat' as SeatName, platform: 'server', node: 'admission-node',
    projectId: 'admission-project' as SeatProjectId,
    directories: [{ path: workspace, startup: true }, { path: dirname(target), startup: false }],
    memoryDirectories: [], opening: { kind: 'text', text: 'Retain protected input.' }, openingInstructionFiles: [],
    wakeTemplate: { kind: 'text', text: 'Retain protected input on wake.' },
    agentPreset: 'admission-agent', provider: 'admission-seat', model: 'synthetic', reasoningEffort: 'admission-effort',
    permissionPreset: 'workspace-write', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1,
    autoKeepAlive: false, maxActiveSubagents: 4, subagentContextThresholdTokens: 400000, rules: [],
    worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
  }
  const saved = await seats.save({ definition, expectedRevision: 1, operationId: 'admission-save' as SeatOperationId })
  expect(saved, JSON.stringify(saved)).toMatchObject({ status: 'saved' })
  const openRequest = { seat: definition.seat, origin: 'manual' as const, openingMode: 'prefill' as const,
    operationId: 'admission-open' as SeatOperationId }
  let opened = await seats.open(openRequest)
  if (opened.status === 'queued') {
    await ctx.get('seatEngine')!.drive()
    opened = await seats.open(openRequest)
  }
  expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'prefilled' })
  if (opened.status !== 'prefilled') throw new Error('Real seat window was not prefilled')
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('Prefilled seat Agent is unavailable')
  const roots = await ctx.get('seatDirectories')!.roots(agent.id)
  const profileRoot = roots.find(item => item.path === dirname(target))
  expect(profileRoot).toMatchObject({ kind: 'additional', writable: true })
  if (profileRoot === undefined) throw new Error('Protected profile root is not registered')
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
  if (name === 'seat_replace') {
    const engine = ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine.SeatEngine)) throw new Error('Missing real replacement engine')
    const waterfall = vi.spyOn(ctx, 'waterfall')
    const eventsRoot = join(root, 'directory-engine', 'ledger', 'engine', 'v1', nodeId, 'events')
    const link = join(workspace, 'seat-replacement-link')
    symlinkSync(dirname(target), link, 'dir')
    const callId = ToolCallId('replacement-admission')
    let retained: unknown
    const path = [target, '../protected-input', join(link, 'cordis.patch.yml')][pathIndex]!
    const windows = ctx.get('seatLocalWindows')!.forInvocation({ session: agent.session, callId })
    for (const index of [0, 1]) {
      // A tool call is dispatched once per residency; retry the durable operation at its provider.
      const result = index === 0 ? await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name, arguments: { sessionId: agent.id, root: path, file_path: path, output_path: path, openingMode: 'prefill' },
        agent, callId, signal: new AbortController().signal,
      })) : { isError: false, content: [], value: JSON.stringify(await windows.replace({
        sessionId: agent.id, operationId: `tool:${agent.id}:${callId}` as SeatOperationId,
      })) }
      if (result.isError) {
        for (const observed of waterfall.mock.results) {
          if (observed.type === 'return') await observed.value
        }
      }
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      if (typeof result.value !== 'string') throw new Error('Missing replacement result')
      const value: unknown = JSON.parse(result.value)
      expect(value).toMatchObject({ status: 'queued', phase: 'queued', oldSessionId: agent.id })
      if (index === 0) retained = value
      else expect(value).toEqual(retained)
      expect(engine.journal.projection.replacements.size).toBe(1)
      expect([...engine.journal.projection.replacements.values()][0]).toMatchObject({
        oldSessionId: agent.id, newSessionId: null, phase: 'queued',
      })
      expect(engine.journal.projection.closed.has(agent.id)).toBe(false)
      expect(ctx.agents.get(agent.id)).toBe(agent)
      const log = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
      expect(log).toContain('window/replacement')
      expect(log).toContain('queue/pending')
      expect(log).toContain(`tool:${agent.id}:${callId}`)
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    return
  }
  if (name === 'seat_open') {
    const prepareCall = vi.spyOn(ctx.llm, 'prepareCall')
    const holds: { agent: Agent; release: () => void; done: Promise<void> }[] = []
    const admissions: Promise<void>[] = []
    ctx.on('agent/created', ({ agent: openedAgent }) => {
      const admission = openedAgent.whenIdle().then(() => {
        const release = Promise.withResolvers<undefined>()
        const done = openedAgent.runMaintenance(() => release.promise)
        holds.push({ agent: openedAgent, release: () => { release.resolve(undefined) }, done })
      })
      admissions.push(admission)
    })
    onTestFinished(async () => {
      await Promise.all(admissions)
      for (const hold of holds) { hold.agent.cancel({ kind: 'disposed' }); hold.release() }
      await Promise.all(holds.map(hold => hold.done))
      expect(prepareCall).not.toHaveBeenCalled()
      expect(modelRequested).toBe(false)
      for (const hold of holds) expect(hold.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    })
    const engine = ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine.SeatEngine)) throw new Error('Missing real opening engine')
    const link = join(workspace, 'seat-opening-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      const seat = `tool-open-seat-${index}` as SeatName
      expect(await seats.save({ definition: { ...definition, seat }, expectedRevision: index + 2,
        operationId: `tool-open-save-${index}` as SeatOperationId })).toMatchObject({ status: 'saved' })
      const callId = ToolCallId(`seat-open-${index}`)
      const invoke = () => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name, arguments: { seat, root: path, file_path: path, output_path: path, openingMode: 'prefill' },
        agent, callId, signal: new AbortController().signal,
      }))
      let result = await invoke()
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      if (typeof result.value !== 'string') throw new Error('Missing opening result')
      if (result.value.includes('"status":"queued"')) { await engine.drive(); result = await invoke() }
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      if (typeof result.value !== 'string') throw new Error('Missing retained opening result')
      const value: unknown = JSON.parse(result.value)
      expect(value).toMatchObject({ status: 'opened', seat, phase: 'opening-pending' })
      const open = [...engine.journal.projection.opens.values()].find(item => item.definition?.seat === seat)
      expect(open).toMatchObject({ openingMode: 'auto', phase: 'opening-pending' })
      if (open === undefined || open.openingMessageId === null) throw new Error('Opening message was not durably sent')
      const openedAgent = ctx.agents.get(open.sessionId)
      if (openedAgent === undefined) throw new Error('Missing live opened window')
      await expect.poll(() => openedAgent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced')).toBe(true)
      await ctx.sessions.flush(openedAgent.session)
      const directory = await ctx.sessionPersistence.sidecarDirectory?.(open.sessionId)
      if (directory === undefined) throw new Error('Missing opened Session storage')
      expect(relative(join(root, 'directory-sessions'), directory).split(/[\\/]/)).not.toContain('..')
      const log = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
      expect(log).toContain('agent/inbox/spliced')
      expect(log).not.toContain('"type":"turn/start"')
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    executed.add('@panedesk/dsh-tool-seat:seat_open')
    return
  }
  if (name === 'seat_windows' || name === 'seat_list_online') {
    await ctx.plugin(UserQuestions)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolSeatMessages)
    await ctx.sessions.flush(agent.session)
    const before = agent.session.seq
    const eventsRoot = join(root, 'directory-engine', 'ledger', 'engine', 'v1', nodeId, 'events')
    const link = join(workspace, 'seat-observation-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name, arguments: { root: path, file_path: path, output_path: path, content: 'replacement' },
        agent, callId: ToolCallId(`seat-observation-${index}`), signal: new AbortController().signal,
      }))
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      if (typeof result.value !== 'string') throw new Error('Missing seat observation response')
      const value: unknown = JSON.parse(result.value)
      if (name === 'seat_windows') expect(value).toMatchObject({ status: 'listed',
        sessions: [{ sessionId: agent.id, seat: definition.seat, engineStatus: 'prefilled' }] })
      else expect(value).toMatchObject([{ sessionId: agent.id, seat: definition.seat }])
      expect(agent.session.seq).toBe(before)
      const log = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
      expect(log).toContain(JSON.stringify(agent.id))
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    if (name === 'seat_windows') {
      const engine = ctx.get('seatEngine')
      if (!(engine instanceof SeatEngine.SeatEngine)) throw new Error('Missing real seat engine')
      for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
        const recoverySeat = `recovery-seat-${index}` as SeatName
        const savedRecovery = await seats.save({ definition: { ...definition, seat: recoverySeat },
          expectedRevision: index + 2, operationId: `recovery-save-${index}` as SeatOperationId })
        expect(savedRecovery).toMatchObject({ status: 'saved' })
        catalogAvailable = false
        const request = { seat: recoverySeat, origin: 'manual' as const, openingMode: 'prefill' as const,
          operationId: `recovery-open-${index}` as SeatOperationId }
        await seats.open(request)
        await engine.drive()
        const failed = [...engine.journal.projection.opens.values()].find(open => open.definition?.seat === recoverySeat)
        expect(failed).toMatchObject({ phase: 'opening-failed', failure: { code: 'open-configuration-failed' } })
        if (failed === undefined) throw new Error('Missing retained failed opening')
        const beforeRecovery = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
          .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
        catalogAvailable = true
        const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
          name, arguments: { root: path, file_path: path, output_path: path, content: 'replacement' },
          agent, callId: ToolCallId(`seat-recovery-${index}`), signal: new AbortController().signal,
        }))
        expect(result.isError, JSON.stringify(result.content)).toBe(false)
        expect(engine.journal.projection.opens.get(failed.sessionId)).toMatchObject({ phase: 'active', failure: null })
        const afterRecovery = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
          .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
        expect(afterRecovery).not.toBe(beforeRecovery)
        expect(afterRecovery).toContain('open/configured')
        const recoveredAgent = ctx.agents.get(failed.sessionId)
        if (recoveredAgent === undefined) throw new Error('Missing recovered live window')
        await ctx.sessions.flush(recoveredAgent.session)
        expect(recoveredAgent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
        expect(readFileSync(target, 'utf8')).toBe(original)
      }
    }
    expect(modelRequested).toBe(false)
    executed.add(name === 'seat_windows' ? '@panedesk/dsh-tool-seat:seat_windows' : '@panedesk/dsh-tool-seat-messages:seat_list_online')
    return
  }
  if (name === 'seat_close') {
    await ctx.plugin(UserQuestions)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
    const eventsRoot = join(root, 'directory-engine', 'ledger', 'engine', 'v1', nodeId, 'events')
    const link = join(workspace, 'seat-close-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      let closingAgent = agent
      if (index > 0) {
        const request = { ...openRequest, operationId: `admission-reopen-${index}` as SeatOperationId }
        let next = await seats.open(request)
        if (next.status === 'queued') { await ctx.get('seatEngine')!.drive(); next = await seats.open(request) }
        if (next.status !== 'prefilled') throw new Error(`Missing close target: ${JSON.stringify(next)}`)
        const live = ctx.agents.get(next.sessionId)
        if (live === undefined) throw new Error('Missing live close target')
        closingAgent = live
      }
      await ctx.sessions.flush(closingAgent.session)
      const listed = await ctx.get('seatLocalRead')!.list({})
      if (listed.status !== 'listed') throw new Error('Missing seat window state')
      const window = listed.sessions.find(item => item.sessionId === closingAgent.id)
      if (window === undefined) throw new Error('Missing close target version')
      expect(window.busyReasons).toEqual([])
      const closed = await ctx.agents.withInitiator(closingAgent, () => ctx.tools.execute({
        name, arguments: { sessionId: closingAgent.id, expectedStateVersion: window.stateVersion,
          root: path, file_path: path, output_path: path },
        agent: closingAgent, callId: ToolCallId(`seat-close-storage-${index}`), signal: new AbortController().signal,
      }))
      expect(closed.isError, JSON.stringify(closed.content)).toBe(false)
      if (typeof closed.value !== 'string') throw new Error('Missing close response')
      expect(JSON.parse(closed.value)).toMatchObject({ status: 'closed', sessionId: closingAgent.id, phase: 'closed' })
      expect(ctx.workspaceRegistry.archivedSessionIds).toContain(closingAgent.id)
      const directory = await ctx.sessionPersistence.sidecarDirectory?.(closingAgent.id)
      if (directory === undefined) throw new Error('Missing closed session directory')
      expect(relative(join(root, 'directory-sessions'), directory).split(/[\\/]/)).not.toContain('..')
      const sessionLog = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
      expect(sessionLog).toContain(' closed')
      expect(sessionLog).not.toContain('"type":"turn/start"')
      const log = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
      expect(log).toContain('window/closed')
      expect(log).toContain(JSON.stringify(closingAgent.id))
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    executed.add('@panedesk/dsh-tool-seat:seat_close')
    return
  }
  if (name === 'seat_send' || name === 'seat_wake') {
    await ctx.plugin(ToolSeatMessages)
    agent.session.append('message/settings', { receiveMode: 'all', wakeOnHandoff: false })
    await ctx.sessions.flush(agent.session)
    const mailboxRoot = join(root, 'directory-mailbox', 'messages', 'nodes')
    const link = join(workspace, 'seat-message-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      const sent = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name, arguments: { seat: definition.seat, sessionId: agent.id, text: path, root: path, file_path: path, output_path: path },
        agent, callId: ToolCallId(`seat-message-storage-${index}`), signal: new AbortController().signal,
      }))
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false)
      if (typeof sent.value !== 'string') throw new Error('Missing seat message response')
      expect(JSON.parse(sent.value)).toMatchObject(name === 'seat_send'
        ? { deliveryOutcome: 'accepted', messageState: 'queued', recipient: { sessionId: agent.id } }
        : { status: 'sent', sessionId: agent.id })
      const records = readdirSync(mailboxRoot, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && basename(entry.parentPath) === 'records' && entry.name.endsWith('.json'))
        .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8')).join('\n')
      expect(records).toContain(name === 'seat_send' ? JSON.stringify(path).slice(1, -1) : 'Retain protected input on wake.')
      if (name === 'seat_send') expect(records).toContain('seat-send-')
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    executed.add(name === 'seat_send' ? '@panedesk/dsh-tool-seat-messages:seat_send' : '@panedesk/dsh-tool-seat:seat_wake')
    return
  }
  if (name === 'seat_wait' || name === 'seat_cancel_wait') {
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
    const settled = Promise.withResolvers<JobOutcome>()
    const cancel = vi.fn(() => { settled.resolve({ status: 'killed' }) })
    onTestFinished(() => { settled.resolve({ status: 'completed' }) })
    const jobId = ctx.agents.withInitiator(agent, () => ctx.jobs.start({
      kind: 'bash', label: 'Pending seat wait observation', owner: agent.id,
      run: () => ({ done: settled.promise, cancel }),
    }))
    await ctx.sessions.flush(agent.session)
    const eventsRoot = join(root, 'directory-engine', 'ledger', 'engine', 'v1', nodeId, 'events')
    const link = join(workspace, 'seat-wait-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      const callId = ToolCallId(`seat-wait-storage-${index}`)
      const waitId = `tool:${agent.session.id}:${callId}`
      const registered = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name: 'seat_wait', arguments: { mode: 'any', objects: [{ kind: 'job', id: jobId }],
          root: path, file_path: path, output_path: path },
        agent, callId, signal: new AbortController().signal,
      }))
      expect(registered.isError, JSON.stringify(registered.content)).toBe(false)
      if (typeof registered.value !== 'string') throw new Error('Missing wait registration response')
      expect(JSON.parse(registered.value)).toMatchObject({ status: 'registered',
        wait: { waitId, sessionId: agent.id, phase: 'registered', stateVersion: 1 } })
      expect(registered.concludesTurn).toBe(true)
      const cancelled = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name: 'seat_cancel_wait', arguments: { waitId, expectedStateVersion: 1,
          root: path, file_path: path, output_path: path },
        agent, callId: ToolCallId(`seat-wait-cancel-${index}`), signal: new AbortController().signal,
      }))
      expect(cancelled.isError, JSON.stringify(cancelled.content)).toBe(false)
      if (typeof cancelled.value !== 'string') throw new Error('Missing wait cancellation response')
      expect(JSON.parse(cancelled.value)).toMatchObject({ status: 'cancelled',
        wait: { waitId, sessionId: agent.id, phase: 'cancelled', stateVersion: 2 } })
      const log = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
      expect(log).toContain('wait/registered')
      expect(log).toContain('wait/cancelled')
      expect(log).toContain(JSON.stringify(waitId))
      expect(ctx.jobs.get(jobId, agent.id).status).toBe('running')
      expect(cancel).not.toHaveBeenCalled()
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    executed.add(`@panedesk/dsh-tool-seat:${name}`)
    return
  }
  if (name === 'seat_report' || name === 'seat_revoke_report') {
    const eventsRoot = join(root, 'directory-engine', 'ledger', 'engine', 'v1', nodeId, 'events')
    const link = join(workspace, 'seat-report-link')
    symlinkSync(dirname(target), link, 'dir')
    for (const [index, path] of [target, '../protected-input', join(link, 'cordis.patch.yml')].entries()) {
      const callId = ToolCallId(`seat-report-storage-${index}`)
      const version = index * 2 + 1
      const recorded = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        name: 'seat_report', arguments: { canClose: false,
          waitingFor: [{ kind: 'other', summary: path }],
          nextOpen: { when: { kind: 'unspecified' }, prerequisites: [path] }, stateVersion: version,
          root: path, file_path: path, output_path: path },
        agent, callId, signal: new AbortController().signal,
      }))
      expect(recorded.isError, JSON.stringify(recorded.content)).toBe(false)
      if (typeof recorded.value !== 'string') throw new Error('Missing report response')
      expect(JSON.parse(recorded.value)).toMatchObject({ status: 'recorded', stateVersion: version })
      if (name === 'seat_revoke_report') {
        const revoked = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
          name, arguments: { reportId: `tool:${agent.session.id}:${callId}`, expectedStateVersion: version,
            root: path, file_path: path, output_path: path },
          agent, callId: ToolCallId(`seat-revoke-storage-${index}`), signal: new AbortController().signal,
        }))
        expect(revoked.isError, JSON.stringify(revoked.content)).toBe(false)
        if (typeof revoked.value !== 'string') throw new Error('Missing revocation response')
        expect(JSON.parse(revoked.value)).toMatchObject({ status: 'revoked', stateVersion: version + 1 })
      }
      const log = readdirSync(eventsRoot).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(eventsRoot, file), 'utf8')).join('\n')
      expect(log).toContain('report/submitted')
      expect(log).toContain(JSON.stringify(path))
      if (name === 'seat_revoke_report') expect(log).toContain('report/revoked')
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    expect(modelRequested).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    executed.add(`@panedesk/dsh-tool-seat:${name}`)
    return
  }
  if (name === 'seat_rename') {
    await ctx.sessions.flush(agent.session)
    const directory = await ctx.sessionPersistence.sidecarDirectory?.(agent.session.id)
    if (directory === undefined) throw new Error('Missing seat session directory')
    const title = 'Renamed seat'
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      name, arguments: { sessionId: agent.session.id, title },
      agent, callId: ToolCallId('seat-title'), signal: new AbortController().signal,
    }))
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    if (typeof result.value !== 'string') throw new Error('Missing seat rename response')
    expect(JSON.parse(result.value)).toMatchObject({ status: 'renamed' })
    await ctx.sessions.flush(agent.session)
    expect(await ctx.sessionPersistence.sidecarDirectory?.(agent.session.id)).toBe(directory)
    const log = readFileSync(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8')
    expect(log).toContain('session/title')
    expect(log).toContain(JSON.stringify(title))
    expect(modelRequested).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    executed.add('@panedesk/dsh-tool-seat:seat_rename')
    return
  }
  const write = vi.spyOn(ctx.fs, 'writeText')
  const edit = vi.spyOn(ctx.fs, 'editText')
  const args = name === 'seat_directories' ? {}
    : name === 'seat_read' ? { rootId: profileRoot.rootId, relativePath: 'cordis.patch.yml', maxBytes: 1000 }
      : name === 'seat_write' ? { rootId: profileRoot.rootId, relativePath: 'cordis.patch.yml', content: 'replacement' }
        : { rootId: profileRoot.rootId, relativePath: 'cordis.patch.yml', oldText: original, newText: 'replacement' }
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: args, agent, callId: ToolCallId(`directory-admission-${name}`), signal: new AbortController().signal,
  }))
  expect(result.isError, JSON.stringify(result.content)).toBe(name === 'seat_write' || name === 'seat_edit')
  if (name === 'seat_directories') expect(JSON.stringify(result.content)).toContain(profileRoot.rootId)
  else if (name === 'seat_read') expect(JSON.stringify(result.content)).toContain('protected original')
  else {
    expect(name === 'seat_write' ? write : edit).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.content)).toContain('protected host path')
  }
  expect(modelRequested).toBe(false)
  expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe(original)
  executed.add(`@panedesk/dsh-tool-seat:${name}`)
})

it.each(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'] as const)('%s denies a caller without identity with the real schedule service', async (name) => {
  const { ctx, root, target, original, call } = await fixture()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'schedule-sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'schedule-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'schedule-storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(DefaultModel, { provider: 'admission-no-model', model: 'admission-no-model' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'schedule-home') })
  await ctx.plugin(LocalCredentials, { path: join(root, 'schedule-home', 'credentials.yaml'), dshHome: join(root, 'schedule-home'), watch: false })
  await ctx.plugin(Connection, {})
  await ctx.plugin(Commands)
  await ctx.plugin(FileUploads)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionController, { nativeOpen: false })
  await ctx.plugin(ScheduleService, {})
  await ctx.plugin(ToolSchedule)
  const args = name === 'schedule_create' ? { title: 'Retain input', prompt: `Keep ${target} unchanged.`, after_seconds: 86400 }
    : name === 'schedule_list' ? {} : name === 'schedule_update' ? { id: 'admission-schedule', title: 'Retain input' }
      : { id: 'admission-schedule' }
  const result = await call(name, args)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ code: 'internal_error' })
  expect(readFileSync(target, 'utf8')).toBe(original)
})

it.each(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'] as const)('%s keeps schedule state under the configured application root', async (name) => {
  const { ctx, root, workspace, target, original } = await fixture()
  const storageRoot = join(root, 'schedule-storage')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'schedule-sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'schedule-index.sqlite'), openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(DefaultModel, { provider: 'admission-no-model', model: 'admission-no-model' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'schedule-home') })
  await ctx.plugin(LocalCredentials, { path: join(root, 'schedule-home', 'credentials.yaml'), dshHome: join(root, 'schedule-home'), watch: false })
  await ctx.plugin(Connection, {})
  await ctx.plugin(Commands)
  await ctx.plugin(FileUploads)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionController, { nativeOpen: false })
  await ctx.plugin(ScheduleService, {})
  await ctx.plugin(ToolSchedule)
  const agent = await ctx.agentLoop.create(SessionId(`schedule-storage-${name}`), {}, { cwd: workspace })
  const alias = join(workspace, 'schedule-output-link')
  symlinkSync(dirname(target), alias, 'dir')
  for (const path of [target, '../protected-input', join(alias, 'cordis.patch.yml')]) {
    const seeded = name === 'schedule_create' ? undefined
      : await ctx.schedule.create(agent.session.id, { title: 'Initial reminder', prompt: 'Retain input', after_seconds: 86400 })
    const args = name === 'schedule_create' ? { title: 'Retain input', prompt: path, after_seconds: 86400 }
      : name === 'schedule_update' ? { id: seeded?.id, title: 'Updated reminder', prompt: path }
        : name === 'schedule_delete' ? { id: seeded?.id } : {}
    if (name === 'schedule_create' || name === 'schedule_update') {
      const rejected = await ctx.tools.execute({
        name, arguments: { ...args, root: path, file_path: path, output_path: path }, agent,
        callId: ToolCallId(`schedule-path-denial-${name}`), signal: new AbortController().signal,
      })
      expect(rejected.value).toMatchObject({ code: 'invalid_selector' })
      expect(readFileSync(target, 'utf8')).toBe(original)
    }
    const result = await ctx.tools.execute({
      name, arguments: args, agent,
      callId: ToolCallId(`schedule-storage-${name}`), signal: new AbortController().signal,
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).not.toHaveProperty('code')
    const stored = await ctx.schedule.list({ sessionId: agent.session.id })
    if (name === 'schedule_create' || name === 'schedule_update') {
      expect(stored).toContainEqual(expect.objectContaining({ prompt: path }))
      expect(readFileSync(join(storageRoot, 'schedule.json'), 'utf8')).toContain(JSON.stringify(path))
    } else if (name === 'schedule_list') {
      expect(result.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: seeded?.id })]))
    } else {
      expect(result.value).toEqual({ id: seeded?.id, deleted: true })
      expect(stored).not.toContainEqual(expect.objectContaining({ id: seeded?.id }))
    }
    expect(readFileSync(join(storageRoot, 'schedule.json'), 'utf8')).toContain('tasks')
    expect(readFileSync(target, 'utf8')).toBe(original)
  }
  executed.add(`@panedesk/dsh-tool-schedule:${name}`)
})

it('requires an executed admission cell for every emitted package and tool pair', async () => {
  const catalog = await collectToolCatalog()
  const missing = catalog.flatMap(entry => entry.schemas.map(schema => `${entry.pkg}:${schema.name}`))
    .filter(key => !executed.has(key) && !unavailableLocally.has(key))
  expect(missing.sort()).toEqual(pendingAdmissionEvidence.map(row => row.key).sort())
  expect(pendingAdmissionEvidence.filter(row => executed.has(row.key))).toEqual([])
  if (process.env.PANEDESK_CI_NATIVE_SANDBOX === 'required') expect([...unavailableLocally]).toEqual([])
})
