/** Real delivery, persisted Agents, and HTTP requests through Loader-owned plugins. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies, createTestGate } from '@panedesk/dsh-agent-loop-testkit'
import * as Instructions from '@panedesk/dsh-agent-instructions'
import { createUserMessage } from '@panedesk/dsh-llm'
import * as Model from '@panedesk/dsh-llm-deepseek-api-key'
import { startMockLlmServer, type MockLlmBehavior } from '@panedesk/dsh-llm-mock-server'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import Delivery from '@panedesk/dsh-message-delivery-local'
import { SessionId } from '@panedesk/dsh-session'
import Ledger, { type LedgerRunId } from '@panedesk/dsh-session-ledger'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@panedesk/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Subscriptions from '../src/index.ts'

function operation(): OperationId { return randomUUID() as OperationId }
function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function wireMessages(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object' || !('messages' in body) || !Array.isArray(body.messages)) {
    throw new Error('Expected a captured chat completion request')
  }
  return body.messages
}

async function harness(sequence: readonly MockLlmBehavior[], subscriptions = false, root?: string) {
  const ownRoot = root === undefined
  root ??= await mkdtemp(join(process.env.PANEDESK_TEST_TEMP_ROOT ?? tmpdir(), 'kernel-delivery-'))
  const home = join(root, randomUUID())
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'first private rule\nunchanged rule\n')
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_AGENTS_HOME', join(home, 'agents'))
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const server = await startMockLlmServer({ sequence, toolName: 'boundary_tool', toolArguments: '{}' })
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      await server.close()
      vi.unstubAllEnvs()
      if (ownRoot) await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, persistence: Persistence, ledger: Ledger, delivery: Delivery,
    instructions: Instructions, subscriptions: Subscriptions, model: Model, loop: AgentLoop,
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const rows = [
    { name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    { name: 'cordis:ledger', config: { dshHome: home } },
    { name: 'cordis:delivery', config: { dshHome: home, nodeId: 'node-a', maxRecordBytes: 1048576,
      maxContentBytes: 65536, maxBatchSize: 100, scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } },
    { name: 'cordis:instructions', config: { maxBytes: 65536 } },
    ...subscriptions ? [{ name: 'cordis:subscriptions', config: { maxBytes: 1048576, watch: false } }] : [],
    { name: 'cordis:model', config: { baseURL: server.baseURL, streamIdleTimeoutMs: 1000 } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]
  const configPath = join(home, 'cordis.yml')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect(ctx.get('agents')).toBeDefined()
  expect(ctx.get('sessions')).toBeDefined()
  expect(ctx.get('sessionPersistence')).toBeDefined()
  expect(ctx.get('messageDelivery')).toBeDefined()
  const parent = await ctx.agents.create({ sessionId: SessionId('seat-a'), meta: { cwd: root },
    agentOptions: { provider: 'deepseek-official', model: 'model-a' } })
  const parentContext = ctx.sessionLedger.contextFor(parent.agent.id)
  if (!parentContext) throw new Error('Parent run attribution is unavailable')
  const childContext = { ...parentContext, sessionId: SessionId('seat-b'), parentSessionId: parent.agent.id,
    parentRunId: parentContext.runId, runId: randomUUID() as LedgerRunId }
  expect(await ctx.sessionLedger.beginRun({ ...childContext, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] }))
    .not.toMatchObject({ kind: 'conflict' })
  const unbindChild = ctx.sessionLedger.bindContext(childContext)
  onTestFinished(async () => {
    await ctx.sessionLedger.finishRun({ runId: childContext.runId, observedAt: Date.now(), endReason: 'completed',
      recovered: false, deliveryState: 'not-requested' })
    unbindChild()
  })
  const child = await ctx.agents.create({ sessionId: SessionId('seat-b'), parentAgent: parent.agent,
    meta: { cwd: root, parentSession: parent.agent.id },
    agentOptions: { provider: 'deepseek-official', model: 'model-a' } })
  return { ctx, parent, child, server, root }
}

it('delivers steer at the next real tool boundary and rejects withdrawal after dispatch', async () => {
  const h = await harness(['tool_call_success', 'success'])
  const entered = createTestGate()
  const release = createTestGate()
  h.ctx.tools.register(defineContentToolFixture({ name: 'boundary_tool', description: 'Wait for an explicit boundary', parameters: {},
    async execute() { entered.release(); await release.wait(); return [{ type: 'text', text: 'tool completed' }] },
  }))
  onTestFinished(() => { release.release() })
  h.child.agent.followup(input('Start the tool.'))
  await Promise.race([entered.wait(), h.child.agent.whenIdle().then(() => {
    const events = h.child.agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end')
    throw new Error(`Agent became idle before the tool: ${JSON.stringify(events)}`)
  })])
  const sent = await h.ctx.agents.withInitiator(h.parent.agent, () => h.ctx.messageDelivery.send({
    target: { sessionId: h.child.agent.id }, messageClass: 'handoff', content: 'Deliver at the next boundary.', operationId: operation(),
  }))
  expect(sent).toMatchObject({ deliveryOutcome: 'accepted', messageState: 'queued' })
  release.release()
  await h.child.agent.whenIdle()
  expect(h.server.requests).toHaveLength(2)
  expect(JSON.stringify(h.server.requests[1]!.body)).toContain('Deliver at the next boundary.')
  const rejected = await h.ctx.agents.withInitiator(h.parent.agent, () => h.ctx.messageDelivery.withdraw({
    messageId: sent.messageId, operationId: operation(), expectedRevision: 0,
  }))
  expect(rejected).toMatchObject({ kind: 'rejected', reason: 'injected' })
  expect(rejected.kind === 'rejected' && rejected.status?.transitions.some(event => event.data.transition === 'injected')).toBe(true)
  const joined = await h.ctx.sessionLedger.querySessions({ sessionId: h.child.agent.id })
  expect(JSON.stringify(joined)).toContain(sent.messageId)
})

it('withdraws queued input through the shared queue mutation before a real request', async () => {
  const h = await harness(['success'])
  const release = createTestGate()
  const parked = h.child.agent.runMaintenance(async () => { await release.wait() })
  onTestFinished(() => { release.release() })
  const sent = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id },
    messageClass: 'handoff', content: 'Withdraw this content.', operationId: operation() })
  await vi.waitFor(() => {
    expect([...h.child.agent.inbox.nextStep, ...h.child.agent.inbox.nextTurn]
      .some(message => message.id === sent.messageId)).toBe(true)
  })
  const withdrawn = await h.ctx.messageDelivery.withdraw({ messageId: sent.messageId, expectedRevision: 0, operationId: operation() })
  expect(withdrawn).toMatchObject({ kind: 'applied', status: { state: 'withdrawn' } })
  release.release()
  await parked
  h.child.agent.followup(input('Natural input.'))
  await h.child.agent.whenIdle()
  expect(h.server.requests).toHaveLength(1)
  expect(JSON.stringify(h.server.requests[0]!.body)).not.toContain('Withdraw this content.')
})

it('notifies parent and child through real preparation and compares captured request prefixes with subscriptions disabled', async () => {
  async function run(enabled: boolean, root?: string) {
    const h = await harness(['tool_call_success', 'tool_call_success', 'success', 'success'], enabled, root)
    let changes = 0
    h.ctx.tools.register(defineContentToolFixture({ name: 'boundary_tool', description: 'Apply an external file change', parameters: {},
      async execute() {
        if (changes++ === 0) await writeFile(join(h.root, 'AGENTS.md'), 'second private rule\nunchanged rule\nextra private rule\n')
        return [{ type: 'text', text: 'tool completed' }]
      },
    }))
    // Both Agents load the same original bytes before either tool changes the file.
    const ready = createTestGate()
    const release = createTestGate()
    let preparing = 0
    const stop = h.ctx.on('agent/request', async (_payload, next) => {
      if (++preparing <= 2) { if (preparing === 2) ready.release(); await release.wait() }
      return next()
    })
    onTestFinished(() => { release.release() })
    h.parent.agent.followup(input('Start the tool.'))
    h.child.agent.followup(input('Start the tool.'))
    await ready.wait()
    stop()
    release.release()
    await Promise.all([h.parent.agent.whenIdle(), h.child.agent.whenIdle()])
    const reminders = [h.parent.agent, h.child.agent].map(agent => agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'message-delivery'))
    if (enabled) {
      expect(reminders.map(events => events.length)).toEqual([1, 1])
      for (const events of reminders) {
        expect(JSON.stringify(events)).not.toContain('private rule')
        expect(JSON.stringify(events)).toContain('instruction-change')
      }
    } else expect(reminders.map(events => events.length)).toEqual([0, 0])
    expect(h.server.requests).toHaveLength(4)
    const initial = wireMessages(h.server.requests[0]!.body)
    expect(initial.length).toBeGreaterThan(0)
    expect(JSON.stringify(initial)).toContain('first private rule')
    const prefixes = h.server.requests.map(request => fingerprint(wireMessages(request.body).slice(0, initial.length)))
    return { ...h, prefixes }
  }
  const enabled = await run(true)
  const disabled = await run(false, enabled.root)
  expect(enabled.prefixes).toEqual(disabled.prefixes)
  expect(new Set(enabled.prefixes).size).toBe(1)
})
