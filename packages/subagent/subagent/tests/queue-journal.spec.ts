/** Durable root tickets through real Session storage and a test-only Loader composition. */
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@panedesk/dsh-session-persistence-jsonl'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import { SessionId, SessionLogOffset } from '@panedesk/dsh-session'
import SubagentRuntime from '../src/index.ts'
import type { SubagentActivation, SubagentQueued } from '../src/types.ts'
import { QueueJournal, type QueueJournalRecord } from '../src/queue-journal.ts'
import { SubagentManager } from '../src/manager.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, fsyncSync: vi.fn(original.fsyncSync) }
})

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function homeDirectory() {
  const home = await mkdtemp(join(import.meta.dirname, '.queue-journal-'))
  homes.push(home)
  return home
}

async function runtime(home: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  Object.assign(ctx.loader.builtins, { include: Include, persistence: JsonlPersistence, subagents: SubagentRuntime, loop: AgentLoop })
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    { name: 'cordis:subagents', config: { maxActiveSubagents: 1, overflow: 'queue', persistQueue: true } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const adapter = new MockAdapter(Array.from({ length: 12 }, () => textResponse('ready')))
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.subagents.registerProvider({ name: 'test-worker', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const result = Promise.withResolvers<import('../src/types.ts').SubagentResult>()
      return { id: SessionId('active-child'), result: result.promise,
        dispose: async () => { result.resolve({ output: [], stopReason: 'aborted' }) } }
    },
  })
  return { ctx, adapter }
}

async function setup() {
  const home = await homeDirectory()
  const { ctx, adapter } = await runtime(home)
  const handle = await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'mock' } })
  const parent = handle.agent
  const directory = await ctx.sessionPersistence.sidecarDirectory!(parent.id)
  if (directory === undefined) throw new Error('Expected materialized parent')
  const path = join(directory, 'subagent-queue.jsonl')
  const request = () => ctx.subagents.requestActivation({ provider: 'test-worker', label: 'private task label',
    request: { parent, prompt: [{ type: 'text', text: 'private task body with credential-like content' }] },
    signal: new AbortController().signal, delivery: 'caller' })
  return { ctx, adapter, parent, handle, home, directory, path, request }
}

function ticket(value: SubagentActivation | SubagentQueued): SubagentQueued {
  if (!('status' in value)) throw new Error('Expected ticket')
  return value
}

function rows(text: string): QueueJournalRecord[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as QueueJournalRecord)
}

it('fsyncs metadata before exposing a ticket and appends dequeue before starting work', async () => {
  const { ctx, parent, path } = await setup()
  const journal = new QueueJournal(ctx)
  await journal.prepare(parent)
  const sync = vi.spyOn(fs, 'fsyncSync')
  const { RootSubagentAdmission } = await import('../src/root-admission.ts')
  const admission = new RootSubagentAdmission(ctx, () => undefined, { notify: () => {} })
  let occupied = true
  const { SubagentError } = await import('../src/error.ts')
  const start = vi.fn(async () => {
    expect(rows(await readFile(path, 'utf8')).map(row => row.state)).toEqual(['queued', 'dequeued'])
    return { childId: SessionId('published-child'), result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
  })
  const queued = await admission.acquire({ provider: 'test-worker', label: 'private label',
    request: { parent, prompt: [{ type: 'text', text: 'private body' }] }, signal: new AbortController().signal, delivery: 'caller' },
  { reserve: () => { if (occupied) throw new SubagentError('full', 'ACTIVATION_LIMIT_REACHED'); occupied = true; return () => { occupied = false } }, start })
  if (queued.status !== 'queued') throw new Error('Expected queue')
  expect(sync).toHaveBeenCalled()
  const record = rows(await readFile(path, 'utf8'))[0]!
  expect(Object.keys(record).sort()).toEqual(['agentType', 'parentSessionId', 'position', 'queuedAt', 'state', 'ticketId'])
  expect(record).toMatchObject({ ticketId: queued.ticketId, agentType: 'test-worker', state: 'queued' })
  expect(JSON.stringify(record)).not.toMatch(/private|prompt|token|secret|label/)
  occupied = false
  admission.released(parent)
  await queued.outcome
  expect(start).toHaveBeenCalledOnce()
})

it('refuses a ticket when fsync fails and never publishes an unconfirmed queue event', async () => {
  const { ctx, path, request } = await setup()
  await request()
  const event = vi.fn()
  ctx.on('subagent/queue', event)
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('injected sync failure') })
  await expect(request()).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED',
    message: 'Subagent capacity reached; queue storage could not be synchronized, no ticket accepted' })
  sync.mockRestore()
  expect(ctx.subagents.listQueued(SessionId('parent')).queuedCount).toBe(0)
  expect(event).not.toHaveBeenCalled()
  // Failed fsync leaves uncertain bytes, never a promise that a ticket was accepted.
  expect(rows(await readFile(path, 'utf8'))).toHaveLength(1)
})

it('records one restart cancellation and one model-visible notice across three cold restores without child ledger starts', async () => {
  const { ctx, parent, path, request, home } = await setup()
  await request()
  const queued = ticket(await request())
  const crashImage = await readFile(path, 'utf8')
  // Restore the exact durable crash prefix after releasing the test process's leases.
  await ctx.fiber.dispose()
  await writeFile(path, crashImage)
  const notices: string[] = []
  for (let restart = 0; restart < 3; restart++) {
    const fresh = await runtime(home)
    await fresh.ctx.plugin(JournalSessionLedger, { dshHome: home })
    const resumed = await fresh.ctx.agents.resume({ resumeSessionId: parent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    await resumed.agent.whenIdle()
    for (const request of fresh.adapter.requests) notices.push(JSON.stringify(request.messages))
    expect((await fresh.ctx.sessionLedger.snapshot()).rows.filter(row => row.kind === 'run' && row.start.sessionId !== parent.id)).toEqual([])
    expect(fresh.ctx.subagents.listQueued(parent.id).queuedCount).toBe(0)
    await fresh.ctx.fiber.dispose()
  }
  const cancelled = rows(await readFile(path, 'utf8')).filter(row => row.state === 'cancelled')
  expect(cancelled).toHaveLength(1)
  expect(cancelled[0]).toMatchObject({ ticketId: queued.ticketId, reason: 'restart' })
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(`Queued subagent dispatch ${queued.ticketId} was cancelled by restart. You may dispatch it again.`)
  expect(rows(await readFile(path, 'utf8')).filter(row => row.state === 'notified')).toHaveLength(1)
})

it.each([
  { interruption: 'before parent notification', expectedNotices: 1 },
  { interruption: 'after durable acceptance before notified append', expectedNotices: 2 },
])('recovers interruption $interruption with $expectedNotices notices and one notified marker', async ({ interruption, expectedNotices }) => {
  const { ctx, parent, path, request, home } = await setup()
  await request()
  const queued = ticket(await request())
  const crashImage = await readFile(path, 'utf8')
  await ctx.fiber.dispose()
  await writeFile(path, crashImage)
  const notices: string[] = []
  // Each wrapper calls the original with its intercepted receiver through .call(this).
  // oxlint-disable-next-line typescript/unbound-method
  const notify = SubagentManager.prototype.notifyQueueRestart
  // oxlint-disable-next-line typescript/unbound-method
  const append = QueueJournal.prototype.append
  const notifySpy = vi.spyOn(SubagentManager.prototype, 'notifyQueueRestart')
  const appendSpy = vi.spyOn(QueueJournal.prototype, 'append')
  let durableNotices = 0
  notifySpy.mockImplementation(async function (this: SubagentManager, parent, ticketId, reason) {
    if (interruption === 'before parent notification') throw new Error('simulated interruption before notice')
    await notify.call(this, parent, ticketId, reason)
    // Read storage, not the in-memory Session, at the acknowledgement point.
    const reader = await parent.ctx.sessionPersistence.open(parent.id, 'read')
    try {
      const { events } = await reader.read()
      durableNotices = events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => JSON.stringify(message.content).includes(ticketId))).length
    } finally { await reader.close() }
    expect(durableNotices).toBe(1)
  })
  appendSpy.mockImplementation(function (this: QueueJournal, parent, record) {
    if (record.state === 'notified') {
      expect(durableNotices).toBe(1)
      throw new Error('simulated interruption before notified append')
    }
    append.call(this, parent, record)
  })
  const interrupted = await runtime(home)
  const warn = vi.spyOn(interrupted.ctx.logger, 'warn')
  const resumed = await interrupted.ctx.agents.resume({ resumeSessionId: parent.id, agentOptions: { provider: 'mock', model: 'mock' } })
  await resumed.agent.whenIdle()
  for (const request of interrupted.adapter.requests) notices.push(JSON.stringify(request.messages))
  expect(warn).toHaveBeenCalledWith('Subagent queue recovery could not finish; session remains available, inspect queue storage before redispatching')
  expect(rows(await readFile(path, 'utf8')).map(row => row.state)).toEqual(['queued', 'cancelled'])
  expect(notices).toHaveLength(expectedNotices - 1)
  notifySpy.mockRestore()
  appendSpy.mockRestore()
  await interrupted.ctx.fiber.dispose()
  for (let restart = 0; restart < 3; restart++) {
    const fresh = await runtime(home)
    const recovered = await fresh.ctx.agents.resume({ resumeSessionId: parent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    await recovered.agent.whenIdle()
    for (const request of fresh.adapter.requests) notices.push(JSON.stringify(request.messages))
    expect(notices).toHaveLength(expectedNotices)
    await fresh.ctx.fiber.dispose()
  }
  const records = rows(await readFile(path, 'utf8'))
  expect(records.map(record => record.state)).toEqual(['queued', 'cancelled', 'notified'])
  expect(records[2]).toMatchObject({ ticketId: queued.ticketId, reason: 'restart' })
  expect(records[2]!.notifiedAt).toBeTypeOf('number')
  expect(Object.keys(records[2]!).sort()).toEqual([
    'agentType', 'cancelledAt', 'notifiedAt', 'parentSessionId', 'position', 'queuedAt', 'reason', 'state', 'ticketId',
  ])
  for (const notice of notices) expect(notice).toContain(`Queued subagent dispatch ${queued.ticketId} was cancelled by restart. You may dispatch it again.`)
})

it('starts and cold-restores with a missing journal without warning', async () => {
  const home = await homeDirectory()
  const { ctx } = await runtime(home)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const parent = await ctx.agents.create({ sessionId: SessionId('missing'), agentOptions: { provider: 'mock', model: 'mock' } })
  expect(warn).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
  const fresh = await runtime(home)
  const freshWarn = vi.spyOn(fresh.ctx.logger, 'warn')
  await fresh.ctx.agents.resume({ resumeSessionId: parent.agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
  expect(freshWarn).not.toHaveBeenCalled()
})

it('skips a damaged middle line and torn tail, warns once, and continues cold restoration', async () => {
  const { ctx, parent, path, request, home } = await setup()
  await request()
  ticket(await request())
  const crashImage = await readFile(path, 'utf8')
  await ctx.fiber.dispose()
  await writeFile(path, `${crashImage}not-json\n{"ticketId":`)
  const fresh = await runtime(home)
  const warn = vi.spyOn(fresh.ctx.logger, 'warn')
  const resumed = await fresh.ctx.agents.resume({ resumeSessionId: parent.id, agentOptions: { provider: 'mock', model: 'mock' } })
  await resumed.agent.whenIdle()
  expect(warn).toHaveBeenCalledExactlyOnceWith('Subagent queue journal contains damaged records; skipped invalid lines, recovery continues')
  expect(await readFile(path, 'utf8')).toContain('"reason":"restart"')
})

it('keeps sidecars out of seeded branches and copies of Session events', async () => {
  const { ctx, parent, path, request } = await setup()
  await request()
  ticket(await request())
  const reader = await ctx.sessionPersistence.open(parent.id, 'read')
  const { events } = await reader.read()
  await reader.close()
  for (const id of ['branch', 'copy']) {
    const child = await ctx.agents.create({ sessionId: SessionId(id), seed: events,
      meta: { parentSession: parent.id, isSeeded: true }, inheritedEventCount: SessionLogOffset(events.length),
      agentOptions: { provider: 'mock', model: 'mock' } })
    const directory = await ctx.sessionPersistence.sidecarDirectory!(child.agent.id)
    expect(directory).toBeDefined()
    await expect(readFile(join(directory!, 'subagent-queue.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.subagents.listQueued(child.agent.id).queuedCount).toBe(0)
  }
  expect(rows(await readFile(path, 'utf8')).filter(row => row.state === 'queued')).toHaveLength(1)
})

it('removes the queue journal with its owning session directory, outside the ledger directory', async () => {
  const { ctx, path, directory, home, request } = await setup()
  await request()
  ticket(await request())
  expect(path).toContain(join(home, 'sessions'))
  expect(path).not.toContain('ledger')
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true })
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
