/** Product limits preserve upstream admission and definition-owned tool restrictions. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import AgentPresets from '@panedesk/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { defineTool } from '@panedesk/dsh-tools'
import SubagentRuntime from '../src/index.ts'
import { delegationDepthOf } from '../src/depth.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'
import { MemoryLedger, seedParentLedger } from './ledger-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

async function setup(maxActiveSubagents: number, script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime, { maxDepth: 3, maxActiveSubagents })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script, { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = (await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'mock' } })).agent
  const maxDepth = ctx.subagents.resolveMaxDepth()
  if (maxDepth === undefined) throw new Error('Expected configured product depth')
  return { ctx, parent, adapter, maxDepth }
}

it('admits sixteen simultaneous fake-model children and retains immediate overflow rejection', async () => {
  const { ctx, parent, adapter } = await setup(16, Array.from({ length: 16 }, () => 'hang' as const))
  const children = await Promise.all(Array.from({ length: 16 }, () => startPreparedActivation({ parent,
    prompt: [{ type: 'text', text: 'work' }], signal: new AbortController().signal })))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(16) })
  expect(children.every(child => ctx.agents.get(child.id)?.status === 'running')).toBe(true)
  expect(ctx.subagents.resolveMaxDepth()).toBe(3)
  await expect(startPreparedActivation({ parent, prompt: [{ type: 'text', text: 'overflow' }], signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  await Promise.all(children.map(child => child.dispose()))
})

it('rejects a descendant at a full shared pool instead of blocking its occupied parent', async () => {
  const { ctx, parent, adapter, maxDepth } = await setup(1, ['hang'])
  const first = await startPreparedActivation({ parent, prompt: [{ type: 'text', text: 'parent work' }], signal: new AbortController().signal })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await expect(startPreparedActivation({ parent: first.localAgent, prompt: [{ type: 'text', text: 'descendant' }],
    maxDepth, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  await first.dispose()
  expect(ctx.agents.get(first.id)).toBeUndefined()
})

it('enforces a read-only preset at depth three without granting a fourth write capability', async () => {
  const { ctx, parent, adapter, maxDepth } = await setup(16, ['hang', 'hang', toolCallResponse('attempt-write', 'write', {}), textResponse('denied')])
  await ctx.plugin(AgentPresets, { default: 'reader' })
  await ctx.plugin(MemoryLedger)
  await seedParentLedger(ctx.sessionLedger as MemoryLedger)
  const writes = vi.fn(() => Promise.resolve('mutated'))
  for (const name of ['read', 'glob', 'grep', 'write']) ctx.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: name === 'write' ? writes : () => Promise.resolve(name),
  }))
  await ctx.agentPresets.register({ id: 'reader', plugins: [], executionPolicy: {
    provider: 'mock', model: 'mock', reasoningEffort: 'high', allowedTools: ['read', 'glob', 'grep'],
    rulesId: 'read-only', version: '1', digest: 'synthetic-read-only',
  } })
  const request = (agent: typeof parent) => ({ parent: agent, prompt: [{ type: 'text' as const, text: 'work' }],
    maxDepth, signal: new AbortController().signal })
  const first = await startPreparedActivation(request(parent))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  const second = await startPreparedActivation(request(first.localAgent))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
  const third = await startPreparedActivation({ ...request(second.localAgent), agentPreset: 'reader' })
  expect((await third.result).stopReason).toBe('completed')
  expect(delegationDepthOf(third.localAgent)).toBe(3)
  expect(adapter.requests[2]?.tools?.map(tool => tool.name).sort()).toEqual(['glob', 'grep', 'read'])
  expect(writes).not.toHaveBeenCalled()
  expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('denies tool')
  await first.dispose()
})
