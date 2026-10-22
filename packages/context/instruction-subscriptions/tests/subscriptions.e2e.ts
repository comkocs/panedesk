/** Loader composition with real sessions, instruction loading, tools, and an explicit pre-claim driver. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { agentEvents, type Agent } from '@panedesk/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { brandString } from '@panedesk/dsh-brand'
import { createUserMessage, ToolCallId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import type { SendMessageRequest, SendMessageResult, NodeId } from '@panedesk/dsh-message-delivery'
import MessageDelivery from '@panedesk/dsh-message-delivery'
import * as Instructions from '@panedesk/dsh-agent-instructions'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import * as Subscriptions from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

class DeliveryStub extends MessageDelivery {
  static inject = ['agents']
  readonly sent: SendMessageRequest[] = []
  override async send(request: SendMessageRequest): Promise<SendMessageResult> {
    this.sent.push(request)
    if (request.target.sessionId === undefined) throw new Error('Expected session address')
    const agent = this.ctx.agents.get(request.target.sessionId)!
    const message = createUserMessage({ content: [{ type: 'text', text: request.content }], source: { kind: 'user' } })
    agent.inbox.append('next-step', message)
    return { messageId: message.id, operationId: request.operationId, deliveryOutcome: 'accepted', messageState: 'queued', pending: false,
      recipient: { nodeId: brandString<NodeId>('node-a'), sessionId: agent.session.id, window: null, title: null,
        status: 'busy', matchedFields: ['sessionId'], observedAt: Date.now() } }
  }
  override withdraw(): never { throw new Error('Unused') }
  override edit(): never { throw new Error('Unused') }
  override reprioritize(): never { throw new Error('Unused') }
  override invalidate(): never { throw new Error('Unused') }
  override status(): never { throw new Error('Unused') }
  override operationStatus(): never { throw new Error('Unused') }
  override list(): never { throw new Error('Unused') }
  override resolve(): never { throw new Error('Unused') }
  override sendBatch(): never { throw new Error('Unused') }
  override configure(): never { throw new Error('Unused') }
  override subscribe(): never { throw new Error('Unused') }
}

async function harness(enabled = true, root?: string, files?: string[]) {
  root ??= await mkdtemp(join(tmpdir(), 'instruction-subscriptions-'))
  if (!roots.includes(root)) roots.push(root)
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'first private rule\r\nunchanged rule\r\n')
  vi.stubEnv('PANEDESK_HOME', join(root, 'home'))
  vi.stubEnv('PANEDESK_AGENTS_HOME', join(root, 'agents'))
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(ToolFs)
  await ctx.plugin(DeliveryStub)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.instructions = Instructions
  ctx.loader.builtins.subscriptions = Subscriptions
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const yaml = await readFile(new URL('./cordis.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  const subscriptions = enabled
    ? '- name: cordis:subscriptions' + yaml.split('- name: cordis:subscriptions')[1]! + (files === undefined ? '' : `    files:\n${files.map(file => `      - ${file}\n`).join('')}`)
    : ''
  await writeFile(configPath, yaml.split('- name: cordis:subscriptions')[0]! + subscriptions)
  const driver = await mountAgentLoopTestHarness(ctx)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const parent = await driver.create(SessionId('seat-a'), {}, { cwd: root })
  const child = (await ctx.agents.create({ sessionId: SessionId('seat-b'), parentAgent: parent,
    meta: { cwd: root, parentSession: parent.session.id }, agentOptions: {} })).agent
  for (const agent of [parent, child]) vi.spyOn(agent, 'status', 'get').mockReturnValue('running')
  async function boundary(agent: Agent) {
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/input-preparing', { turn: 1, step: 1, signal })
    const messages = driver.claim(agent, 'next-step', 1)
    messages.push(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal },
      async () => ({ kind: 'enter', messages }))
    if (decision.kind !== 'enter') throw new Error('Expected admitted request')
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    return agent.session.deriveMessages()
  }
  async function write(agent: Agent, content: string) {
    return ctx.tools.execute({ agent, name: 'write', callId: ToolCallId('write-rule'),
      arguments: { file_path: join(root!, 'AGENTS.md'), content }, signal: new AbortController().signal })
  }
  return { ctx, root, parent, child, boundary, write, delivery: ctx.messageDelivery as DeliveryStub }
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

it('notifies independently loaded parent and child and preserves request prefixes against a plugin-free control', async () => {
  const enabled = await harness()
  const before = await enabled.boundary(enabled.parent)
  await enabled.boundary(enabled.child)
  await writeFile(join(enabled.root, 'AGENTS.md'), 'second private rule\nunchanged rule\nextra private rule\n')
  const after = await enabled.boundary(enabled.parent)
  await enabled.boundary(enabled.child)
  expect(enabled.delivery.sent).toHaveLength(2)
  const reminder: unknown = JSON.parse(enabled.delivery.sent[0]!.content)
  expect(reminder).toMatchObject({ status: 'present', added: 2, removed: 1 })
  expect(enabled.delivery.sent.every(request => request.priority === 'steer')).toBe(true)
  expect(enabled.delivery.sent[0]!.content).not.toContain('private rule')
  process.stdout.write(`REMINDER ${enabled.delivery.sent[0]!.content.replaceAll(enabled.root, '<workspace>')}\n`)
  const control = await harness(false, enabled.root)
  const controlBefore = await control.boundary(control.parent)
  await control.boundary(control.child)
  await writeFile(join(control.root, 'AGENTS.md'), 'second private rule\nunchanged rule\nextra private rule\n')
  const controlAfter = await control.boundary(control.parent)
  await control.boundary(control.child)
  const prefix = (messages: typeof before) => messages.slice(0, before.length)
    .map(message => ({ role: message.role, content: message.content }))
  const pairs = { withPlugin: [digest(prefix(before)), digest(prefix(after))],
    withoutPlugin: [digest(prefix(controlBefore)), digest(prefix(controlAfter))] }
  expect(pairs.withPlugin).toEqual(pairs.withoutPlugin)
  process.stdout.write(`PREFIX_COMPARISON ${JSON.stringify(pairs)}\n`)
  process.stdout.write(`UPSTREAM_EXTERNAL_PREFIX ${JSON.stringify({ before: pairs.withoutPlugin[0], after: pairs.withoutPlugin[1] })}\n`)
  expect(JSON.stringify(controlAfter)).toContain('second private rule')
  expect(JSON.stringify(after)).toContain('instruction-change')
})

it('suppresses evidenced self-writes only for the writer while preserving upstream recomposition', async () => {
  const h = await harness()
  await h.boundary(h.parent)
  await h.boundary(h.child)
  expect((await h.write(h.parent, 'self-written private rule\r\n')).isError).toBe(false)
  const after = await h.boundary(h.parent)
  await h.boundary(h.child)
  expect(h.delivery.sent.map(request => request.target.sessionId)).toEqual([h.child.session.id])
  expect(JSON.stringify(after)).toContain('self-written private rule')
})

it('reminds after a version mismatch makes successful self-write evidence unavailable', async () => {
  const h = await harness()
  await h.boundary(h.parent)
  await agentEvents(h.ctx, h.parent).serial('agent/input-preparing', {
    turn: 1, step: 1, signal: new AbortController().signal,
  })
  const evidence: unknown[] = []
  h.ctx.on('instructions/written', ({ file }) => { evidence.push(file.evidence) })
  const original = h.ctx.fs.readBytes.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementationOnce(async (...args) => {
    await writeFile(join(h.root, 'AGENTS.md'), 'external competing rule\n')
    return original(...args)
  })
  expect((await h.write(h.parent, 'self-written rule\n')).isError).toBe(false)
  await h.boundary(h.parent)
  expect(evidence).toEqual([{ status: 'unavailable', reason: 'version-mismatch' }])
  expect(h.delivery.sent).toHaveLength(1)
  process.stdout.write(`SELF_WRITE_EVIDENCE ${JSON.stringify({ evidence, reminders: h.delivery.sent.length })}\n`)
})

it('reminds on another session write, deletion, recovery, and ignores idle agents', async () => {
  const h = await harness()
  await h.boundary(h.parent)
  await h.boundary(h.child)
  await h.write(h.child, 'another session rule\n')
  await h.boundary(h.parent)
  expect(h.delivery.sent).toHaveLength(1)
  await rm(join(h.root, 'AGENTS.md'))
  await h.boundary(h.parent)
  expect(JSON.parse(h.delivery.sent[1]!.content) as object).toMatchObject({ status: 'deleted' })
  vi.spyOn(h.parent, 'status', 'get').mockReturnValue('idle')
  await writeFile(join(h.root, 'AGENTS.md'), 'recovered rule\n')
  await h.boundary(h.parent)
  expect(h.delivery.sent).toHaveLength(2)
  vi.spyOn(h.parent, 'status', 'get').mockReturnValue('running')
  await h.boundary(h.parent)
  expect(h.delivery.sent).toHaveLength(3)
  expect(JSON.parse(h.delivery.sent[2]!.content) as object).toMatchObject({ status: 'present', oldHash: null, added: 1, removed: 0 })
})

const note = 'notes/plan.md'

function logTypes(agent: Agent): string[] {
  return agent.session.snapshotEvents().map(event => event.type)
}

function reminderFor(sent: DeliveryStub['sent'], path: string): Record<string, unknown> {
  const matches = sent.filter(request => request.content.includes(path))
  expect(matches).toHaveLength(1)
  return JSON.parse(matches[0]!.content) as Record<string, unknown>
}

it('reminds once for an externally edited configured file and preserves request prefixes against a plugin-free control', async () => {
  const original = 'first note line\nunchanged note line\n'
  const edited = 'second note line\nunchanged note line\nextra note line\n'
  async function seat(enabled: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'instruction-subscriptions-'))
    roots.push(root)
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, note), original)
    return { ...(await harness(enabled, root, enabled ? [note] : undefined)), notePath: join(root, note) }
  }
  const enabled = await seat(true)
  const before = await enabled.boundary(enabled.parent)
  await enabled.boundary(enabled.child)
  const unchanged = await enabled.boundary(enabled.parent)
  expect(enabled.delivery.sent).toHaveLength(0)
  const control = await seat(false)
  const controlBefore = await control.boundary(control.parent)
  await control.boundary(control.child)
  const controlUnchanged = await control.boundary(control.parent)
  expect(logTypes(enabled.parent)).toEqual(logTypes(control.parent))
  expect(logTypes(enabled.child)).toEqual(logTypes(control.child))
  await writeFile(enabled.notePath, edited)
  const after = await enabled.boundary(enabled.parent)
  const reminder = reminderFor(enabled.delivery.sent, enabled.notePath)
  expect(reminder).toEqual({
    kind: 'instruction-change', path: enabled.notePath, status: 'present',
    oldHash: createHash('sha256').update(original).digest('hex'),
    newHash: createHash('sha256').update(edited).digest('hex'),
    added: 2, removed: 1,
  })
  expect(enabled.delivery.sent).toHaveLength(1)
  expect(JSON.stringify(reminder)).not.toContain('note line')
  process.stdout.write(`CONFIGURED_FILE_REMINDER ${JSON.stringify(reminder).replaceAll(enabled.root, '<workspace>')}\n`)
  expect(JSON.stringify(after)).not.toContain('Updated instructions')
  await writeFile(control.notePath, edited)
  const controlAfter = await control.boundary(control.parent)
  expect(control.delivery.sent).toHaveLength(0)
  expect(JSON.stringify(controlAfter)).not.toContain('Updated instructions')
  expect(JSON.stringify(controlAfter)).not.toContain('note line')
  const prefix = (messages: typeof before) => messages.slice(0, before.length)
    .map(message => ({ role: message.role, content: message.content }))
  const pairs = { withPlugin: [digest(prefix(before)), digest(prefix(unchanged)), digest(prefix(after))],
    withoutPlugin: [digest(prefix(controlBefore)), digest(prefix(controlUnchanged)), digest(prefix(controlAfter))] }
  expect(pairs.withPlugin).toEqual(pairs.withoutPlugin)
  await rm(enabled.notePath)
  await enabled.boundary(enabled.parent)
  expect(reminderFor(enabled.delivery.sent.slice(1), enabled.notePath)).toMatchObject({
    kind: 'instruction-change', path: enabled.notePath, status: 'deleted', oldHash: reminder.newHash, newHash: null,
  })
})
