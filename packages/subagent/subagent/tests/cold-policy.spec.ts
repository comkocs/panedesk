import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import AgentPresets from '@panedesk/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@panedesk/dsh-subagent/internal'
import * as SubagentSpawn from '@panedesk/dsh-subagent-spawn-in-process'
import { defineTool } from '@panedesk/dsh-tools'
import SubagentRuntime from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryLedger, seedParentLedger } from './ledger-fixture.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { TestSessionQuery } from './test-session-query.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const policy = { provider: 'mock', model: 'model-a', reasoningEffort: 'high', allowedTools: ['one', 'two', 'three'], rulesId: 'rules-a', version: '1', digest: 'rules-digest' }

async function setup(controlled = true, withLedger = true, deliveries = false) {
  const ctx = new Context()
  contexts.push(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-cold-policy-'))
  roots.push(root)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentPresets, { default: 'legacy' })
  await ctx.agentPresets.register({ id: 'legacy', plugins: [] })
  const unregister = await ctx.agentPresets.register({ id: 'child', plugins: [], ...controlled ? { executionPolicy: policy } : {} })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  if (withLedger) {
    await ctx.plugin(MemoryLedger)
    await seedParentLedger(ctx.sessionLedger as MemoryLedger)
  }
  const executed = vi.fn(() => Promise.resolve('four'))
  for (const name of ['one', 'two', 'three', 'four']) ctx.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: name === 'four' ? executed : () => Promise.resolve(name) }))
  const adapter = new MockAdapter([textResponse('first'), toolCallResponse('call-a', 'four', {}), textResponse('done')],
    { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = (await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'model-a' },
    setup: async (childCtx) => { await ctx.agentPresets.mount(childCtx, 'legacy') } })).agent
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
  const started = await ctx.subagents.startActivation({ provider: 'spawn', label: 'work', delivery: 'caller',
    request: { parent, agentPreset: 'child', prompt: [{ type: 'text', text: 'work' }], ...deliveries ? { deliveryPaths: ['result.txt'] } : {} }, signal: new AbortController().signal })
  await started.result
  const resume = () => queueHostSubagentPrompt(ctx.subagents, parent, started.childId,
    [{ type: 'text', text: 'continue' }], { kind: 'user' }, new AbortController().signal)
  const settled = () => vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
  return { ctx, parent, started, resume, settled, unregister, adapter, executed, ledger: ctx.get('sessionLedger') as MemoryLedger | undefined }
}

describe('ledger-backed cold execution policy', () => {
  it('retains the original three-tool policy after the definition widens on cold resume', async () => {
    const { ctx, unregister, resume, settled, executed, ledger, adapter } = await setup()
    expect(ledger!.starts[1]?.executionPolicy).toEqual(policy)
    expect(ledger!.starts[1]?.executionPolicyDigest).toMatch(/^[a-f0-9]{64}$/)
    await unregister()
    await ctx.agentPresets.register({ id: 'child', plugins: [], executionPolicy: { ...policy, allowedTools: [...policy.allowedTools, 'four'] } })
    await resume()
    await settled()
    expect(executed).not.toHaveBeenCalled()
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('Execution policy rules-a@1 denies tool')
    expect(ledger!.starts[2]?.executionPolicy).toEqual(policy)
    expect(ledger!.events.some(event => event.kind === 'alert' && event.alert.code === 'subagent-definition-changed')).toBe(true)
  })

  it('refuses cold resume after the definition removes its execution policy', async () => {
    const { ctx, unregister, resume, adapter } = await setup()
    await unregister()
    await ctx.agentPresets.register({ id: 'child', plugins: [] })
    await expect(resume()).rejects.toThrow('execution policy was removed')
    expect(adapter.requests).toHaveLength(1)
  })

  it('refuses controlled cold resume without a ledger', async () => {
    const { resume, adapter } = await setup(true, false)
    await expect(resume()).rejects.toThrow('requires a ledger')
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps legacy uncontrolled cold resume working without a ledger', async () => {
    const { resume, settled, executed } = await setup(false, false)
    await resume()
    await settled()
    expect(executed).toHaveBeenCalledOnce()
  })

  it('preserves delivery declarations and checks them again after cold resume', async () => {
    const { ledger, resume, settled } = await setup(true, true, true)
    const paths = ledger!.starts[1]!.deliveryPaths
    expect(paths).toHaveLength(1)
    await resume()
    await settled()
    expect(ledger!.starts[2]!.deliveryPaths).toEqual(paths)
    expect(ledger!.finishes.map(finish => finish.deliveryState)).toEqual(['missing', 'missing'])
  })

  it.each(['missing', 'digest', 'incomplete'] as const)('refuses controlled cold resume with %s ledger evidence', async (failure) => {
    const { ledger, resume, adapter } = await setup()
    if (failure === 'missing') ledger!.starts.splice(1)
    else if (failure === 'digest') ledger!.starts[1]!.executionPolicyDigest = 'invalid'
    else {
      const snapshot = ledger!.snapshot.bind(ledger)
      vi.spyOn(ledger!, 'snapshot').mockImplementation(async filter => ({ ...await snapshot(filter), complete: false }))
    }
    await expect(resume()).rejects.toMatchObject({ code: 'POLICY_RESTORE_DENIED' })
    expect(adapter.requests).toHaveLength(1)
  })
})
