import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import Agents from '@panedesk/dsh-agent'
import Loop from '@panedesk/dsh-agent-loop'
import Llm, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import Sessions from '@panedesk/dsh-session'
import Projections from '@panedesk/dsh-session-projection'
import Prompt from '@panedesk/dsh-system-prompt'
import Tools from '@panedesk/dsh-tools'
import Fs from '@panedesk/dsh-fs-local'
import WorkingDirectory from '@panedesk/dsh-working-directory'
import Storage from '@panedesk/dsh-storage'
import * as Json from '@panedesk/dsh-storage-json'
import * as Domain from '@panedesk/dsh-storage-domain'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import Ledger from '@panedesk/dsh-session-ledger'
import Delivery from '@panedesk/dsh-message-delivery-local'
import Workspace from '@panedesk/dsh-workspace'
import Title from '@panedesk/dsh-session-title'
import Defaults from '@panedesk/dsh-agent-default-model'
import Attachments from '@panedesk/dsh-attachment-local'
import Access from '@panedesk/dsh-api-remote-access'
import Typert from '@panedesk/dsh-typert-registry'
import Controller from '@panedesk/dsh-api-session-controller'
import Permissions from '@panedesk/dsh-permission-presets'
import Approval from '@panedesk/dsh-user-approval'
import Commands from '@panedesk/dsh-commands'
import Sandbox from '@panedesk/dsh-sandbox-policy'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import * as Cache from '@panedesk/dsh-llm-cache'
import * as Local from '@panedesk/dsh-seat-local'
import * as Engine from '@panedesk/dsh-seat-engine'
import type * as T from '@panedesk/dsh-seat'
import Query from '@panedesk/dsh-session-query-sqlite'
import Credentials from '@panedesk/dsh-credentials-local'
import * as Connection from '@panedesk/dsh-client-connection'
import Uploads from '@panedesk/dsh-client-file-upload'
import Subprocess from '@panedesk/dsh-subprocess-local'
import Shell from '@panedesk/dsh-bash-sandbox'
import SandboxLocal from '@panedesk/dsh-sandbox-local'
import Questions from '@panedesk/dsh-user-questions'
import Jobs from '@panedesk/dsh-jobs-local'
import Schedule from '@panedesk/dsh-schedule'
import * as Gates from '@panedesk/dsh-seat-gates'
import Remote from '@panedesk/dsh-seat-remote'
import TokenMeter from '@panedesk/dsh-token-meter'
import Compaction from '@panedesk/dsh-compaction-basic'
import Pruner from '@panedesk/dsh-compaction-tool-result-pruner'
import WebServer from '@panedesk/dsh-host-webserver'
import * as FileTools from '@panedesk/dsh-tool-fs'
import * as SeatTools from '@panedesk/dsh-tool-seat'
import { credentialRef } from '@panedesk/dsh-credentials'
import Subagents from '@panedesk/dsh-subagent'
import * as Spawn from '@panedesk/dsh-subagent-spawn-in-process'
import * as CompactionLedger from '@panedesk/dsh-compaction-ledger'
import { definition as neutralDefinition } from '../../../seat-local/tests/fixtures.ts'
import { trigger as neutralTrigger } from '../../../seat-engine/tests/fixtures.ts'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function until(check: () => Promise<boolean> | boolean, timeout = 5000) {
  const start = performance.now()
  while (!await check()) {
    if (performance.now() - start >= timeout) throw new Error('Observable condition timed out')
    await delay(10)
  }
}

export const operation = (value = randomUUID()) => value as T.SeatOperationId
export const seatName = (value: string) => value as T.SeatName
export const projectId = 'project-a' as T.SeatProjectId

export class Model extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  retention: '1h' | '5m' = '1h'
  failure = false
  private release: (() => void) | undefined
  private barrier: Promise<void> | undefined
  hold() { this.barrier = new Promise<void>((resolve) => { this.release = resolve }) }
  finish() { this.release?.(); this.barrier = undefined }
  override providerInfo(provider: string) { return { id: provider, name: provider } }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'model-a', name: 'model-a' }]) }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1000000 },
      reasoning: { efforts: [{ id: ReasoningEffortId('effort-a'), name: 'effort-a' }], defaultEffort: ReasoningEffortId('effort-a') } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.barrier
    if (this.failure) throw new Error('External model failure')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Task received.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Task received.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' }, responseModel: 'model-a', responseModelReported: 'same',
      cacheRetention: this.retention, cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, accountLabel: 'account-a' }
  }
}

export async function fixture(options: {
  home?: string
  preserve?: boolean
  barrier?: string
  engine?: Partial<T.SeatEngineConfig>
  aliases?: Record<string, T.SeatNodeId>
  gates?: T.GateDefinition[]
  onBase?: (ctx: Context) => Promise<void>
} = {}) {
  const home = options.home ?? await mkdtemp(join(process.cwd(), '.acceptance-'))
  const ctx = new Context()
  let engineReadyAt = 0
  ctx.on('seat/ready', () => { engineReadyAt = performance.now() })
  const model = new Model()
  const callbacks: T.SeatCallbackPayload[] = []
  let failures = 0
  const sourceId = 'source-a' as T.SeatSourceId
  const disposers: (() => void | Promise<void>)[] = []
  async function close() {
    model.finish()
    try {
      for (const agent of ctx.get('agents')?.list() ?? []) await agent.whenIdle()
      await ctx.get('seatEngine')?.shutdown()
      for (const dispose of disposers.reverse()) await dispose()
      await ctx.fiber.dispose()
    } finally { if (!options.preserve) await rm(home, { recursive: true, force: true }) }
  }
  try {
    await mkdir(join(home, 'workspace-a'), { recursive: true })
    for (const path of ['workspace-b', 'memory-a', 'memory-b', 'memory-shared']) await mkdir(join(home, path), { recursive: true })
    if (options.barrier) ctx.on('seat/decision', (decision) => {
      if (!decision.effects.some(effect => effect.kind === options.barrier)) return
      writeFileSync(join(home, 'kill-barrier.json'), JSON.stringify({ stage: options.barrier, pid: process.pid }))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    })
    ctx.baseUrl = `${pathToFileURL(home).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, agents: Agents, loop: Loop, llm: Llm,
      sessions: Sessions, projections: Projections, prompt: Prompt, tools: Tools, fs: Fs,
      working: WorkingDirectory, storage: Storage, json: Json, domain: Domain, persistence: Persistence,
      ledger: Ledger, delivery: Delivery, workspace: Workspace, title: Title, defaults: Defaults,
      attachments: Attachments, access: Access, typert: Typert, controller: Controller,
      permissions: Permissions, approval: Approval, commands: Commands, sandbox: Sandbox,
      subscriptions: Subscriptions, cache: Cache, local: Local, engine: Engine, query: Query,
      credentials: Credentials, connection: Connection, uploads: Uploads, subprocess: Subprocess,
      shell: Shell, confinement: SandboxLocal, questions: Questions, jobs: Jobs, schedule: Schedule,
      gates: Gates, remote: Remote, tokenMeter: TokenMeter, compaction: Compaction, pruner: Pruner,
      web: WebServer, fileTools: FileTools, seatTools: SeatTools, subagents: Subagents, spawn: Spawn, compactionLedger: CompactionLedger })
    const entries = JSON.parse(await readFile(new URL('./cordis.yml', import.meta.url), 'utf8')
      .then(text => text.replaceAll('$HOME', home))) as { name: string; config?: object }[]
    const loopback = [127, 0, 0, 1].join('.')
    const web = entries.find(entry => entry.name === 'cordis:web')!
    web.config = { host: loopback, port: 0 }
    if (options.gates) {
      const gates = entries.find(entry => entry.name === 'cordis:gates')!
      gates.config = { ...gates.config, definitions: options.gates }
    }
    const configPath = join(home, 'cordis.yml')
    await writeFile(configPath, JSON.stringify(entries.filter(entry => entry.name !== 'cordis:remote')))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    ctx.llm.registerAdapter(['provider-a'], model)
    const signing = randomBytes(32).toString('hex')
    await ctx.credentials.set(credentialRef('ACCEPTANCE_SIGNING'), signing)
    await until(() => ctx.get('webServer')?.port !== undefined)
    const port = ctx.webServer.port!
    async function webhook(valid: boolean, eventId: string) {
      const body = JSON.stringify({ eventId, eventType: 'neutral-event', data: null })
      const timestamp = String(Date.now())
      const signature = createHmac('sha256', signing).update(`${timestamp}.`).update(body).digest('hex')
      const response = await fetch(`http://${loopback}:${port}/seat-events`, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-seat-source': 'source-http', 'x-seat-timestamp': timestamp,
          'x-seat-key-version': 'v1', 'x-seat-signature': valid ? signature : '0'.repeat(64) } })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) as object : null }
    }
    await options.onBase?.(ctx)
    const nodeId = await ctx.sessionLedger.nodeId()
    const definition = (name = 'seat-a', overrides: Partial<T.SeatDefinition> = {}) => neutralDefinition(join(home, 'workspace-a'), {
      seat: seatName(name), autoKeepAlive: false, node: 'node-a', memoryDirectories: [join(home, 'memory-a'), join(home, 'memory-shared')],
      wakeTemplate: { kind: 'text', text: 'Continue {{seat}}.' }, ...overrides })
    const defaults = definition()
    const config = { nodeName: 'node-a', nodeAliases: { 'node-a': nodeId, ...options.aliases }, dedupWindowMs: 1000,
      maxDecisionBytes: 500000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
      callbackTimeoutMs: 1000, callbackMaxResponseBytes: 4096, callbackRetryInitialMs: 10, callbackRetryMaxMs: 100,
      ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000, ...options.engine }
    const localConfig = { directory: home, nodeId, nodeName: 'node-a', nodeAliases: config.nodeAliases, defaults,
      maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
      pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: String.fromCodePoint(32, 0x5173, 0x7a97) }
    const seatPath = join(home, 'seat.yml')
    await writeFile(seatPath, JSON.stringify([{ name: 'cordis:engine', config: { ...config, home } },
      { name: 'cordis:local', config: localConfig }, entries.find(entry => entry.name === 'cordis:remote')!]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(seatPath).href } })
    await ctx.loader.await()
    await until(() => Boolean(ctx.get('seats') && ctx.get('seatEngine')))
    await ctx.seatEngine.ready()
    const seats = ctx.seats.withAuthority({ principalId: 'owner' as T.SeatPrincipalId, origin: 'manual', nodeId })
    const engine = ctx.seatEngine
    disposers.push(engine.registerSource({ sourceId, kinds: ['external', 'manual', 'schedule', 'git', 'window-ended', 'handoff-timeout'],
      maxRedeliveryMs: null, callback: async (payload) => { callbacks.push(payload); if (failures-- > 0) throw new Error('Callback retry') } }))
    async function save(def: T.SeatDefinition) {
      const catalog = await seats.definitions({})
      if (catalog.revision === 0) assert.equal((await seats.setAuthority({ authority: 'seat-store', expectedRevision: 0,
        authorizationRef: 'owner' as T.AuthorizationRef, operationId: operation() })).status, 'saved')
      const revision = (await seats.definitions({})).revision
      assert.equal((await seats.save({ definition: def, expectedRevision: revision, operationId: operation() })).status, 'saved')
    }
    async function open(name = 'seat-a', extra: Partial<T.OpenSeatRequest> = {}) {
      const result = await seats.open({ seat: seatName(name), origin: 'manual', openingMode: 'auto', operationId: operation(), ...extra })
      assert.equal(result.status, 'opened', JSON.stringify(result))
      if (result.status !== 'opened') throw new Error('Opening did not create a session')
      return result
    }
    async function settle() {
      await until(async () => {
        await engine.drive()
        for (const agent of ctx.agents.list()) {
          await agent.whenIdle()
          const failed = agent.session.snapshotEvents().find(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
          if (failed?.type === 'turn/end' && failed.data.reason.kind === 'error') throw new Error(JSON.stringify(failed.data.reason))
        }
        const facts = (await engine.query({ limit: 10000 })).effects
        const latest = new Map<string, T.EngineOpenData>()
        for (const effect of facts) if (effect.kind === 'open/configured' || effect.kind === 'open/created') latest.set(effect.data.sessionId, effect.data)
        if (![...latest.values()].every(open => open.phase === 'active')) return false
        for (const agent of ctx.agents.list()) {
          await ctx.sessions.flush(agent.session)
          const messages = await ctx.sessionLedger.queryMessages({ targetSessionId: agent.id, includeTerminal: true })
          if (messages.items.some(message => message.state === 'queued' || message.state === 'injected')) return false
        }
        return true
      })
    }
    const effects = async () => (await engine.query({ limit: 10000 })).effects
    return { home, ctx, model, seats, engine, nodeId, engineReadyAt, port, pid: process.pid, webhook,
      definition, save, open, settle, effects, close,
      callbacks, sourceId, trigger(kind: T.SeatTrigger['kind'] = 'external', id: string = randomUUID(), name = 'seat-a') {
        return { ...neutralTrigger(kind, id, seatName(name)), receivedAt: new Date().toISOString() }
      }, failCallbacks(count: number) { failures = count } }
  } catch (error) { await close(); throw error }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>

export function childFixture(home: string, stage: string) {
  const child = fork(fileURLToPath(import.meta.url), ['acceptance-worker', home, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
  })
  const pid = child.pid
  const messages: object[] = []
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object') messages.push(message)
  })
  const exited = once(child, 'exit')
  const ready = until(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${output}`)
    return messages.some(message => 'stage' in message && message.stage === stage)
      || (stage.startsWith('open/') && existsSync(join(home, 'kill-barrier.json')))
  }, 10000)
  async function stop() {
    if (child.pid !== pid) throw new Error('Worker identity changed')
    await stopChild(child)
  }
  return { pid, ready, exited, messages, output: () => output, stop }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

if (process.argv[2] === 'acceptance-worker') {
  const home = process.argv[3]!
  const stage = process.argv[4]!
  const recovery = stage === 'recover' || stage === 'owner-recover'
  const f = await fixture({ home, preserve: true, ...(recovery || stage === 'owner-held' ? {} : { barrier: stage }) })
  try {
    if (stage === 'owner-held') {
      for (const name of ['seat-a', 'seat-b']) await f.save(f.definition(name, { rules: [{ id: 'rule-a' as never,
        enabled: true, trigger: { kind: 'external', sourceId: f.sourceId }, timeWindows: [], exclusiveTags: ['exclusive-a'] }] }))
      await f.engine.setProjectMode({ projectId, mode: 'auto', expectedRevision: 0, operationId: operation() })
      for (const name of ['seat-a', 'seat-b']) await f.engine.accept(f.trigger('external', name, name))
      await f.engine.drive()
      process.send?.({ stage, pid: process.pid })
    } else if (stage === 'owner-recover') {
      await until(async () => {
        await f.engine.drive()
        if ((await f.ctx.sessionPersistence.list()).length >= 2) return true
        return performance.now() - f.engineReadyAt >= 5000
      }, 6000)
      await writeFile(join(home, 'owner-recovery.json'), JSON.stringify({ effects: await f.effects(),
        pending: await f.engine.pending({ limit: 10 }), milliseconds: performance.now() - f.engineReadyAt }))
      process.send?.({ stage, pid: process.pid })
    } else if (!recovery) {
      await f.save(f.definition())
      await f.open()
    } else {
      const started = performance.now()
      const failure = await f.settle().then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error))
      const effects = await f.effects()
      const physical = (await f.ctx.sessionPersistence.list()).map(item => ({ sessionId: item.header.id, exists: true }))
      await writeFile(join(home, 'recovery.json'), JSON.stringify({ effects, physical, failure, milliseconds: performance.now() - started }))
      process.send?.({ stage, pid: process.pid })
    }
    await new Promise<void>(() => {})
  } finally { await f.close() }
}
