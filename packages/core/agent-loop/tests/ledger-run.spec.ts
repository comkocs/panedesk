import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { brandString, type Branded } from '@panedesk/dsh-brand'
import { createUserMessage, LlmError } from '@panedesk/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@panedesk/dsh-launch-environment'
import type { LedgerNodeId } from '@panedesk/dsh-session-ledger'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MemoryLedger, seedParentLedger } from '../../../subagent/subagent/tests/ledger-fixture.ts'
import { beginAgentRun } from '../src/ledger-run.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

it('records a top-level residency before publication and settles it once after disposal', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as MemoryLedger
  ctx.on('agent/created', () => { expect(ledger.starts).toHaveLength(1) })
  const handle = await ctx.agents.create({ sessionId: SessionId('session-a') })
  expect(ledger.starts[0]).toMatchObject({ sessionId: 'session-a', seat: 'free', window: 'free' })
  expect(ledger.finishes).toHaveLength(0)
  await Promise.all([handle.dispose(), handle.dispose()])
  expect(ledger.finishes).toHaveLength(1)
  expect(ledger.finishes[0]).toMatchObject({ endReason: 'completed', recovered: false })
})

it.each(['completed', 'timeout', 'error', 'cancelled'] as const)('records the top-level %s terminal from runtime evidence', async (expected) => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as MemoryLedger
  const adapter = new MockAdapter([expected === 'timeout'
    ? () => { throw new LlmError('Request timed out', 'TIMEOUT') }
    : expected === 'error' ? () => { throw new Error('Request failed') } : textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('session-a'), agentOptions: { provider: 'mock', model: 'model-a' } })
  const message = createUserMessage({ content: [{ type: 'text', text: 'task-a' }], source: { kind: 'user' } })
  if (expected === 'cancelled') handle.agent.send(message, 'next-turn', false)
  else {
    handle.agent.followup(message)
    await handle.agent.whenIdle()
  }
  await handle.dispose()
  expect(ledger.finishes).toHaveLength(1)
  expect(ledger.finishes[0]).toMatchObject({ endReason: expected, recovered: false })
})

it.each(['startup', 'environment', 'settings', 'free'] as const)('binds %s identity before top-level publication', async (source) => {
  const ctx = new Context()
  contexts.push(ctx)
  const labels = { seat: 'seat-a', window: 'window-a', taskId: 'task-a' }
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: source === 'environment'
    ? { PANEDESK_SEAT: labels.seat, PANEDESK_WINDOW: labels.window, PANEDESK_TASK_ID: labels.taskId } : {} }]))
  if (source === 'startup') ctx.provide('ledgerStartupIdentity', labels)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [], ...source === 'settings' ? { ledgerIdentity: labels } : {} })
  const ledger = ctx.sessionLedger as MemoryLedger
  const handle = await ctx.agents.create({ sessionId: SessionId('session-a') })
  expect(ledger.starts[0]).toMatchObject({ ...(source === 'free' ? { seat: 'free', window: 'free', taskId: 'free' } : labels),
    identitySource: source })
  expect(ledger.contextFor(handle.agent.id)?.runId).toBe(ledger.starts[0]?.runId)
  await handle.dispose()
  expect(ledger.contextFor(handle.agent.id)).toBeUndefined()
})

it('refuses publication when the optional ledger cannot persist a start', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as MemoryLedger
  ledger.failStart = true
  const announced = vi.fn()
  ctx.on('agent/created', announced)
  await expect(ctx.agents.create({ sessionId: SessionId('session-a') })).rejects.toThrow('synchronization')
  expect(announced).not.toHaveBeenCalled()
  expect(ctx.agents.get(SessionId('session-a'))).toBeUndefined()
})

it.each([true, false])('reuses inherited run only when its local start exists: %s', async (visible) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryLedger)
  const ledger = ctx.sessionLedger as MemoryLedger
  const sessionId = SessionId('child-local')
  await seedParentLedger(ledger, sessionId)
  const parent = ledger.contextFor(sessionId)!
  ledger.bindContext({ ...parent, subagentRunId: brandString<Branded<'SubagentRunId'>>(parent.runId) })
  if (visible) await ledger.beginRun({ ...parent, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  const finish = await beginAgentRun(ctx, sessionId)
  expect(ledger.starts).toHaveLength(1)
  if (visible) expect(finish).toBeUndefined()
  else {
    expect(ledger.starts[0]).toMatchObject({ parentRunId: parent.runId, sessionId })
    expect(ledger.starts[0]?.runId).not.toBe(parent.runId)
    await finish!([], false)
    expect(ledger.finishes).toHaveLength(1)
  }
})

it.each(['session', 'node'] as const)('rejects a bound run with a different %s identity before publication', async (identity) => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as MemoryLedger
  const sessionId = SessionId('session-a')
  await seedParentLedger(ledger, sessionId)
  const bound = ledger.contextFor(sessionId)!
  await ledger.beginRun({ ...bound, startedAt: Date.now(), launchState: 'started', deliveryPaths: [],
    ...identity === 'session' ? { sessionId: SessionId('other-session') }
      : { nodeId: brandString<LedgerNodeId>('other-node') } })
  const announced = vi.fn()
  ctx.on('agent/created', announced)
  for (const inherited of [false, true]) {
    const unbind = ledger.bindContext({ ...bound,
      ...inherited ? { subagentRunId: brandString<Branded<'SubagentRunId'>>(bound.runId) } : {} })
    try {
      await expect(ctx.agents.create({ sessionId })).rejects.toThrow('run identity conflicted')
      expect(announced).not.toHaveBeenCalled()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally { unbind() }
  }
  expect(ledger.starts).toHaveLength(1)
  expect(ledger.finishes).toHaveLength(0)
})

it.each(['finished', 'incomplete'] as const)('does not reuse a %s bound residency', async (state) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryLedger)
  const ledger = ctx.sessionLedger as MemoryLedger
  const sessionId = SessionId('session-a')
  await seedParentLedger(ledger, sessionId)
  const bound = ledger.contextFor(sessionId)!
  await ledger.beginRun({ ...bound, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  if (state === 'finished') {
    await ledger.finishRun({ runId: bound.runId, observedAt: Date.now(), endReason: 'completed',
      recovered: false, deliveryState: 'not-requested' })
  } else {
    const snapshot = await ledger.snapshot()
    vi.spyOn(ledger, 'snapshot').mockResolvedValue({ ...snapshot, complete: false })
  }
  await expect(beginAgentRun(ctx, sessionId)).rejects.toThrow(state === 'finished' ? 'already finished' : 'snapshot is incomplete')
  expect(ledger.starts).toHaveLength(1)
  expect(ledger.finishes).toHaveLength(state === 'finished' ? 1 : 0)
})

it('settles a caller-started run when publication fails without removing the caller binding', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryLedger)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as MemoryLedger
  const sessionId = SessionId('session-a')
  await seedParentLedger(ledger, sessionId)
  const bound = ledger.contextFor(sessionId)!
  await ledger.beginRun({ ...bound, startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  ctx.on('agent/created', () => { throw new Error('Publication failed') })
  await expect(ctx.agents.create({ sessionId })).rejects.toThrow('Publication failed')
  expect(ledger.starts).toHaveLength(1)
  expect(ledger.finishes).toEqual([expect.objectContaining({ runId: bound.runId, endReason: 'error' })])
  expect(ledger.contextFor(sessionId)).toEqual(bound)
})

it('preserves creation and teardown without the optional ledger', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const handle = await ctx.agents.create({ sessionId: SessionId('session-a') })
  await handle.dispose()
  expect(ctx.agents.get(SessionId('session-a'))).toBeUndefined()
})
