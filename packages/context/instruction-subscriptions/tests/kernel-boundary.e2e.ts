/** Real delivery, persisted Agents, and HTTP requests through Loader-owned plugins. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { load as loadYaml } from 'js-yaml'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include, { entryListSchema } from '@panedesk/cordis-plugin-include'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies, createTestGate } from '@panedesk/dsh-agent-loop-testkit'
import * as Instructions from '@panedesk/dsh-agent-instructions'
import { createUserMessage } from '@panedesk/dsh-llm'
import * as Model from '@panedesk/dsh-llm-deepseek-api-key'
import { startMockLlmServer, type MockLlmBehavior, type MockLlmServerOptions } from '@panedesk/dsh-llm-mock-server'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import Delivery from '@panedesk/dsh-message-delivery-local'
import { FileMailbox } from '@panedesk/dsh-message-delivery-local/src/mailbox.ts'
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

async function bundleRows(bundle: 'base' | 'sdk-minimal') {
  const patches = loadYaml(await readFile(new URL(`../../../bundle/${bundle}/cordis.patch.yml`, import.meta.url), 'utf8'),
    { schema: entryListSchema }) as { insert?: { id: string; name: string; config?: object; inject?: string[] }[] }[]
  const names: Record<string, string> = { 'session-ledger': 'ledger', 'message-delivery': 'delivery',
    'instruction-subscriptions': 'subscriptions' }
  return patches.flatMap(patch => patch.insert ?? []).filter(row => row.id in names)
    .map(row => ({ ...row, name: `cordis:${names[row.id]}` }))
}

async function harness(
  sequence: readonly MockLlmBehavior[], subscriptions = false, root?: string, mock: Partial<MockLlmServerOptions> = {},
  ledgerAvailable = true, bundle?: 'base' | 'sdk-minimal',
) {
  const ownRoot = root === undefined
  root ??= await mkdtemp(join(process.env.PANEDESK_TEST_TEMP_ROOT ?? tmpdir(), 'kernel-delivery-'))
  const home = join(root, randomUUID())
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'first private rule\nunchanged rule\n')
  vi.stubEnv('PANEDESK_HOME', home)
  vi.stubEnv('PANEDESK_AGENTS_HOME', join(home, 'agents'))
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const server = await startMockLlmServer({ sequence, toolName: 'boundary_tool', toolArguments: '{}', ...mock })
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
  const rows: { name: string; config?: object; inject?: string[] }[] = [
    { name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    ...ledgerAvailable ? [{ name: 'cordis:ledger', config: { dshHome: home } }] : [],
    { name: 'cordis:delivery', config: { dshHome: home, maxRecordBytes: 1048576,
      maxContentBytes: 65536, maxBatchSize: 100, scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } },
    { name: 'cordis:instructions', config: { maxBytes: 65536 } },
    ...subscriptions ? [{ name: 'cordis:subscriptions', config: { maxBytes: 1048576, watch: false } }] : [],
    { name: 'cordis:model', config: { baseURL: server.baseURL, streamIdleTimeoutMs: 1000 } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]
  if (bundle) {
    rows.splice(1, 2, ...await bundleRows(bundle))
  }
  const configPath = join(home, 'cordis.yml')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect(ctx.get('agents')).toBeDefined()
  expect(ctx.get('sessions')).toBeDefined()
  expect(ctx.get('sessionPersistence')).toBeDefined()
  if (ledgerAvailable) expect(ctx.get('messageDelivery')).toBeDefined()
  else expect(ctx.get('messageDelivery')).toBeUndefined()
  const parent = await ctx.agents.create({ sessionId: SessionId('seat-a'), meta: { cwd: root },
    agentOptions: { provider: 'deepseek-official', model: 'model-a' } })
  if (!ledgerAvailable) return { ctx, parent, child: parent, server, root }
  const [resolved] = await ctx.messageDelivery.resolve([{ sessionId: parent.agent.id }])
  expect(resolved).toMatchObject({ kind: 'resolved', recipient: { nodeId: await ctx.sessionLedger.nodeId() } })
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

it.each(['base', 'sdk-minimal'] as const)('loads shipped %s message rows through Loader and disposes their services', async (bundle) => {
  const h = await harness(['success'], false, undefined, {}, true, bundle)
  const sent = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id }, messageClass: 'handoff',
    content: 'Use the shipped delivery configuration.', operationId: operation() })
  await vi.waitFor(() => { expect(h.server.requests).toHaveLength(1) })
  await h.child.agent.whenIdle()
  await vi.waitFor(async () => {
    expect(await h.ctx.messageDelivery.status(sent.messageId)).toMatchObject({ state: 'responded' })
  })
  const deliveryEntry = [...h.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:delivery')
  expect(deliveryEntry?.fiber).toBeDefined()
  await deliveryEntry!.fiber!.dispose()
  expect(h.ctx.get('messageDelivery')).toBeUndefined()
})

it('keeps legacy Agent startup and prompting available when the ledger node cannot be resolved', async () => {
  const h = await harness(['success'], false, undefined, {}, false)
  h.parent.agent.followup(input('Use the legacy input path.'))
  await h.parent.agent.whenIdle()
  expect(h.server.requests).toHaveLength(1)
  expect(JSON.stringify(h.server.requests[0]!.body)).toContain('Use the legacy input path.')
  expect(h.ctx.get('messageDelivery')).toBeUndefined()
})

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

it('aborts a real HTTP stream for immediate input and preserves queued work for continuation', async () => {
  const streaming = createTestGate()
  const h = await harness(['success', 'success', 'success'], false, undefined, {
    async beforeChunk(record) {
      if (record.attempt !== 1 || record.chunksSent < 2) return
      streaming.release()
      if (!record.signal.aborted) await new Promise<void>((resolve) => {
        record.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  })
  h.child.agent.followup(input('Start streaming.'))
  await streaming.wait()
  const queued = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id },
    messageClass: 'handoff', priority: 'queue', content: 'Retain queued work.', operationId: operation() })
  const immediate = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id },
    messageClass: 'handoff', priority: 'immediate', content: 'Handle urgent work.', operationId: operation() })
  expect(immediate.deliveryOutcome).toBe('accepted')
  await h.server.requests[0]!.abortConfirmed
  await h.child.agent.whenIdle()
  expect(h.server.requests[0]!.chunksSent).toBeGreaterThan(0)
  expect(h.server.requests[0]!.signal.aborted).toBe(true)
  const events = h.child.agent.session.snapshotEvents()
  const endings = events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
  expect(endings[0]).toBe('aborted')
  expect(endings.slice(1)).toContain('completed')
  for (const id of [immediate.messageId, queued.messageId]) {
    expect(events.filter(event => event.type === 'user/message' && event.data.id === id)).toHaveLength(1)
  }
  const continuation = h.server.requests.slice(1).map(record => JSON.stringify(record.body)).join('\n')
  expect(continuation).toContain('Handle urgent work.')
  expect(continuation).toContain('Retain queued work.')
})

it('arbitrates offline withdrawal and edit before a real resumed Agent claims input', async () => {
  const h = await harness(['success', 'success'])
  h.child.agent.followup(input('Create durable session history.'))
  await h.child.agent.whenIdle()
  await h.ctx.sessions.flush(h.child.agent.session)
  await h.child.dispose()
  await vi.waitFor(async () => {
    expect(await h.ctx.messageDelivery.resolve([{ sessionId: h.child.agent.id }]))
      .toMatchObject([{ kind: 'resolved', recipient: { status: 'closed' } }])
  })
  const withdrawn = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id },
    messageClass: 'handoff', content: 'Never dispatch this offline message.', operationId: operation() })
  const edited = await h.ctx.messageDelivery.send({ target: { sessionId: h.child.agent.id },
    messageClass: 'handoff', content: 'Replace this offline message.', operationId: operation() })
  expect(withdrawn).toMatchObject({ deliveryOutcome: 'rejected', reason: 'target-closed-pending', messageState: 'queued', pending: true })
  expect(await h.ctx.messageDelivery.withdraw({ messageId: withdrawn.messageId, operationId: operation(), expectedRevision: 0 }))
    .toMatchObject({ kind: 'accepted-pending-owner' })
  expect(await h.ctx.messageDelivery.edit({ messageId: edited.messageId, operationId: operation(), expectedRevision: 0,
    content: 'Dispatch only the revised offline message.' })).toMatchObject({ kind: 'accepted-pending-owner' })
  expect(h.server.requests).toHaveLength(1)
  const resumed = await h.ctx.agents.resume({ resumeSessionId: h.child.agent.id, parentAgent: h.parent.agent,
    agentOptions: { provider: 'deepseek-official', model: 'model-a' } })
  await vi.waitFor(() => { expect(h.server.requests).toHaveLength(2) })
  await resumed.agent.whenIdle()
  const body = JSON.stringify(h.server.requests[1]!.body)
  expect(body).toContain('Dispatch only the revised offline message.')
  expect(body).not.toContain('Never dispatch this offline message.')
  expect(body).not.toContain('Replace this offline message.')
  expect(await h.ctx.messageDelivery.status(withdrawn.messageId)).toMatchObject({ state: 'withdrawn' })
  expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === withdrawn.messageId))
    .toHaveLength(0)
})

it('wakes idle real Agents for handoff and reply within five seconds of durable publication', async () => {
  const h = await harness(['success', 'success'])
  const persisted = new Map<string, number>()
  // The observer invokes the original with the same receiver before recording publication.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = FileMailbox.prototype.append
  const observation = vi.spyOn(FileMailbox.prototype, 'append').mockImplementation(async function (this: FileMailbox, ...args) {
    const record = await original.apply(this, args)
    persisted.set(record.operationId, performance.now())
    return record
  })
  onTestFinished(() => { observation.mockRestore() })
  const starts = new Map<string, number>()
  h.ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') starts.set(session.id, performance.now())
  })
  const handoffOperation = operation()
  const handoff = await h.ctx.agents.withInitiator(h.parent.agent, () => h.ctx.messageDelivery.send({
    target: { sessionId: h.child.agent.id }, messageClass: 'handoff', content: 'Review this item.', operationId: handoffOperation,
  }))
  await vi.waitFor(() => { expect(starts.has(h.child.agent.id)).toBe(true) }, { timeout: 5000, interval: 10 })
  await h.child.agent.whenIdle()
  expect(handoff.deliveryOutcome).toBe('accepted')
  const replyOperation = operation()
  const reply = await h.ctx.agents.withInitiator(h.child.agent, () => h.ctx.messageDelivery.send({
    target: { sessionId: h.parent.agent.id }, messageClass: 'reply', replyTo: handoff.messageId,
    content: 'Review completed.', operationId: replyOperation,
  }))
  await vi.waitFor(() => { expect(starts.has(h.parent.agent.id)).toBe(true) }, { timeout: 5000, interval: 10 })
  await h.parent.agent.whenIdle()
  expect(reply.deliveryOutcome).toBe('accepted')
  const handoffMs = starts.get(h.child.agent.id)! - persisted.get(handoffOperation)!
  const replyMs = starts.get(h.parent.agent.id)! - persisted.get(replyOperation)!
  for (const elapsed of [handoffMs, replyMs]) {
    expect(elapsed).toBeGreaterThanOrEqual(0)
    expect(elapsed).toBeLessThanOrEqual(5000)
  }
  expect(h.server.requests).toHaveLength(2)
  expect(JSON.stringify(h.server.requests[0]!.body)).toContain('Review this item.')
  expect(JSON.stringify(h.server.requests[1]!.body)).toContain('Review completed.')
  process.stdout.write(JSON.stringify({ handoffMs, replyMs, watch: false, realKernel: true }) + '\n')
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
