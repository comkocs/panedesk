/** Root queue admission through the production manager and fake model loop. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@panedesk/dsh-brand'
import { JournalSessionLedger, type LedgerRunId } from '@panedesk/dsh-session-ledger'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { defineTool } from '@panedesk/dsh-tools'
import * as ToolSubagent from '../../tool-subagent/src/index.ts'
import SubagentRuntime from '../src/index.ts'
import type { SubagentActivation, SubagentQueued } from '../src/types.ts'
import type { SubagentQueueEvent } from '../src/root-admission.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from './local-activation.ts'
import { MemoryLedger, seedParentLedger } from './ledger-fixture.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function setup(capacity: number, overflow: 'error' | 'queue' = 'queue') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime, { maxDepth: 3, maxActiveSubagents: capacity, overflow })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: 40 }, () => 'hang' as const))
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.subagents.registerProvider({ name: 'local', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
    prepareContinuable: async () => ({}) })
  const parentHandle = await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'mock' } })
  const parent = parentHandle.agent
  const events: SubagentQueueEvent[] = []
  ctx.on('subagent/queue', (event) => { events.push(event) })
  const spec = (label: string, owner = parent, signal = new AbortController().signal) => ({
    provider: 'local', label, signal, delivery: 'caller' as const,
    request: { parent: owner, maxDepth: 3, agentOptions: { provider: 'mock', model: 'mock' },
      prompt: [{ type: 'text' as const, text: label }] },
  })
  const request = (label: string, owner = parent, signal = new AbortController().signal) =>
    ctx.subagents.requestActivation(spec(label, owner, signal))
  const park = async () => {
    const entered = Promise.withResolvers<typeof parent>()
    const release = Promise.withResolvers<undefined>()
    const off = ctx.on('agent/pre-step', async ({ agent }, next) => {
      entered.resolve(agent)
      await release.promise
      return next()
    })
    try {
      const activation = await ctx.subagents.startActivation(spec('park'))
      const child = await entered.promise
      child.steer(createUserMessage({ content: [{ type: 'text', text: 'parked input' }], source: { kind: 'user' } }))
      ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
      release.resolve(undefined)
      await child.whenIdle()
      expect(child.status).toBe('idle')
      expect(child.inbox.nextStep).toHaveLength(1)
      return activation
    } finally { release.resolve(undefined); off() }
  }
  return { ctx, parent, parentHandle, adapter, events, spec, request, park }
}

function queued(value: SubagentActivation | SubagentQueued): SubagentQueued {
  if (!('status' in value)) throw new Error('Expected queued ticket')
  expect(value.status).toBe('queued')
  return value
}

it.each([2, 16])('returns positions at parked capacity %i and lets the root call another tool before FIFO dequeue', async (capacity) => {
  const { ctx, parent, events, park, request } = await setup(capacity)
  const children: SubagentActivation[] = []
  for (let index = 0; index < capacity; index++) children.push(await park())
  await ctx.plugin(MemoryLedger)
  const ledger = ctx.sessionLedger as MemoryLedger
  await seedParentLedger(ledger)
  const pending = [queued(await request('first')), queued(await request('second')), queued(await request('third'))]
  expect(pending.map(ticket => ticket.position)).toEqual([1, 2, 3])
  expect(ctx.subagents.listQueued(parent.id)).toMatchObject({ queuedCount: 3, earliestQueuedAt: pending[0]!.queuedAt })
  expect(ledger.starts).toHaveLength(0)
  await ctx.plugin(ToolSubagent, { provider: 'local' })
  const continued = vi.fn(async () => 'root continued')
  ctx.tools.register(defineTool({ name: 'continue_work', description: 'Continue root work', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: continued }))
  const rootAdapter = new MockAdapter([
    toolCallResponse('queue-call', 'subagent', { description: 'Extra task', prompt: 'Queued task' }),
    toolCallResponse('next-call', 'continue_work', {}), textResponse('done'),
  ])
  ctx.llm.registerAdapter(['root'], rootAdapter)
  parent.options.provider = 'root'
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate and continue' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  expect(continued).toHaveBeenCalledOnce()
  expect(JSON.stringify(rootAdapter.requests[1]?.messages)).toContain('position 4')
  expect(ledger.events.filter(event => event.kind === 'run/start')).toHaveLength(0)
  const extra = ctx.subagents.listQueued(parent.id).tickets[3]!
  expect(extra.position).toBe(4)
  for (let index = 0; index < 3; index++) {
    await children[index % capacity]!.dispose()
    const outcome = await pending[index]!.outcome!
    if ('status' in outcome) throw new Error('Expected dequeued activation')
    children[index % capacity] = outcome
    expect(ledger.starts).toHaveLength(index + 1)
  }
  expect(events.filter(event => event.state === 'dequeued').map(event => event.ticketId)).toEqual(pending.map(ticket => ticket.ticketId))
  await ctx.subagents.drainDescendants([parent])
  expect(ctx.subagents.listQueued(parent.id).queuedCount).toBe(0)
})

it('cancels a queued ticket without a full-journal run start and preserves the remaining FIFO', async () => {
  const { ctx, parent, events, park, request } = await setup(1)
  const active = await park()
  const home = await mkdtemp(join(import.meta.dirname, '.root-queue-ledger-'))
  homes.push(home)
  await ctx.plugin(JournalSessionLedger, { dshHome: home })
  const ledger = ctx.sessionLedger
  const context = { sessionId: parent.id, rootSessionId: parent.id, runId: brandString<LedgerRunId>('parent-run'),
    nodeId: await ledger.nodeId(), seat: 'seat-a', window: 'window-a', identitySource: 'startup' as const, accountLabel: 'unknown' }
  ledger.bindContext(context)
  await ledger.beginRun({ ...context, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  const childRuns = async () => (await ledger.snapshot()).rows.filter(row => row.kind === 'run' && row.start.sessionId !== parent.id)
  const first = queued(await request('cancel'))
  const second = queued(await request('run'))
  first.cancel!()
  await expect(first.outcome).resolves.toEqual({ status: 'cancelled', reason: 'caller-cancelled' })
  expect(await childRuns()).toEqual([])
  expect(ctx.subagents.listQueued(parent.id).tickets[0]?.position).toBe(1)
  await active.dispose()
  const outcome = await second.outcome!
  if ('status' in outcome) throw new Error('Expected activation')
  expect(await childRuns()).toHaveLength(1)
  expect(events.map(event => event.state)).toEqual(['queued', 'queued', 'cancelled', 'dequeued'])
  await outcome.dispose()
})

it.each(['error', 'queue'] as const)('rejects nested overflow under %s and does not let an occupied child await a ticket', async (overflow) => {
  const { ctx, parent, park, spec } = await setup(1, overflow)
  const active = await park()
  const child = ctx.agents.get(active.childId)!
  await expect(ctx.subagents.requestActivation(spec('nested', child))).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  if (overflow === 'error') await expect(ctx.subagents.requestActivation(spec('root'))).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  expect(ctx.subagents.listQueued(parent.id).queuedCount).toBe(0)
  await active.dispose()
})

it('runs sixteen fake-model children and queues the seventeenth while composing another admission provider', async () => {
  const { ctx, parent, adapter, spec, request } = await setup(16)
  const acquire = vi.fn(async () => ({ status: 'reserved' as const, release: async () => {} }))
  ctx.provide('subagentAdmission', { acquire, continue: async () => {}, resume: acquire })
  const active = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.subagents.startActivation(spec(`run-${index}`))))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(16) })
  const ticket = queued(await request('seventeenth'))
  expect(ticket.position).toBe(1)
  expect(acquire).toHaveBeenCalledTimes(16)
  const child = ctx.agents.get(active[0]!.childId)!
  await expect(request('nested seventeenth', child)).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  await expect(ctx.subagents.sendMessage(child, SessionId(ticket.ticketId), [], {
    signal: new AbortController().signal,
  })).rejects.toBeDefined()
  ticket.cancel!()
  await ctx.subagents.drainDescendants([parent])
})

it('gives repeated request objects independent grants and dispatches each request once', async () => {
  const { ctx, parent, park, spec } = await setup(1)
  const active = await park()
  const start = vi.fn(async () => {})
  ctx.provide('subagentDispatch', { start, continue: async () => {}, returned: async () => {} })
  const repeated = spec('same request')
  const first = queued(await ctx.subagents.requestActivation(repeated))
  const second = queued(await ctx.subagents.requestActivation(repeated))
  await active.dispose()
  const one = await first.outcome!
  if ('status' in one) throw new Error('Expected first activation')
  expect(ctx.subagents.listQueued(parent.id).queuedCount).toBe(1)
  await one.dispose()
  const two = await second.outcome!
  if ('status' in two) throw new Error('Expected second activation')
  expect(start).toHaveBeenCalledTimes(2)
  expect(one.childId).not.toBe(two.childId)
  await two.dispose()
  const third = await ctx.subagents.startActivation(spec('capacity reused'))
  await third.dispose()
})

it('hands a dequeued request to another provider ticket without reporting startup failure', async () => {
  const { ctx, parent, park, request } = await setup(1)
  const active = await park()
  const ticket = queued(await request('queued locally'))
  const downstream: SubagentQueued = { status: 'queued', ticketId: brandString<SubagentQueued['ticketId']>('downstream-ticket'),
    parentSessionId: parent.id }
  ctx.provide('subagentAdmission', { acquire: async () => downstream, continue: async () => {}, resume: async () => downstream })
  await active.dispose()
  await expect(ticket.outcome).resolves.toBe(downstream)
  expect(ctx.subagents.listQueued(parent.id).queuedCount).toBe(0)
})

it.each(['signal', 'ending', 'interrupt'] as const)('cancels all unpublished work on %s', async (mode) => {
  const { ctx, parent, parentHandle, park, request } = await setup(1)
  await park()
  const controller = new AbortController()
  const ticket = queued(await request('queued', parent, controller.signal))
  if (mode === 'signal') controller.abort()
  else if (mode === 'ending') await parentHandle.dispose()
  else {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(parent.status).toBe('running') })
    parent.cancel({ kind: 'user' })
    await parent.whenIdle()
  }
  await expect(ticket.outcome).resolves.toMatchObject({ status: 'cancelled' })
  expect(ctx.subagents.listQueued(parent.id).queuedCount).toBe(0)
})
