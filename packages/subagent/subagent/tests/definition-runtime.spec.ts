import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import AgentPresets from '@panedesk/dsh-agent-preset-registry'
import { ReasoningEffortId, ToolCallId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { defineTool } from '@panedesk/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@panedesk/dsh-ptc-runtime'
import SubagentRuntime from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'
import { MemoryLedger, seedParentLedger } from './ledger-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const policy = { provider: 'mock', model: 'model-a', reasoningEffort: 'high', allowedTools: ['one', 'two', 'three'], rulesId: 'rules-a', version: '1', digest: 'rules-digest' }

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 1000 } }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    await expect(request.bindings[0]!.functions.four!({})).rejects.toThrow('Execution policy rules-a@1 denies tool')
    return { logs: [] }
  }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('done')], ptc = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: ptc ? 'ptc' : 'native' } })
  if (ptc) await ctx.plugin(BindingRuntime)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'controlled' })
  await ctx.plugin(MemoryLedger)
  const ledger = ctx.sessionLedger as MemoryLedger
  await seedParentLedger(ledger)
  const executed: string[] = []
  const register = (target: Context, name: string) => target.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { executed.push(name); return Promise.resolve(name) },
  }))
  for (const name of ['one', 'two', 'three', 'four']) register(ctx, name)
  await ctx.agentPresets.register({ id: 'controlled', executionPolicy: policy, plugins: [] })
  const adapter = new MockAdapter(script, { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') })
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'parent-model' },
    setup: async (childCtx) => { await ctx.agentPresets.mount(childCtx, 'controlled') },
  })
  const parent = handle.agent
  const request = { parent, prompt: [{ type: 'text' as const, text: 'task' }], signal: new AbortController().signal }
  return { ctx, parent, adapter, ledger, executed, register, request }
}

describe('definition-controlled local execution', () => {
  it('uses the definition model in the transcript and exposes only three inherited tools', async () => {
    const { adapter, request } = await setup()
    const run = await startPreparedActivation(request)
    expect((await run.result).stopReason).toBe('completed')
    expect(adapter.requests[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'high' })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['one', 'three', 'two'])
    expect(run.localAgent.session.requestHeader()?.config.model).toBe('model-a')
  })

  it('returns a direct fourth-tool refusal to the model and durably records it', async () => {
    const { adapter, ledger, executed, request } = await setup([toolCallResponse('call-a', 'four', {}), textResponse('denied')])
    const run = await startPreparedActivation(request)
    await run.result
    expect(executed).toEqual([])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Execution policy rules-a@1 denies tool')
    expect(ledger.events.some(event => event.kind === 'policy/denied' && event.requested === 'four')).toBe(true)
  })

  it('fork keeps descriptions but returns the fourth-tool error and awaits denied facts before run end', async () => {
    const { adapter, ledger, executed, request } = await setup([toolCallResponse('call-a', 'four', {}), textResponse('denied')])
    const gate = Promise.withResolvers<undefined>()
    ledger.denyBarrier = gate.promise
    const run = await startPreparedActivation(request, { seed: [] })
    let settled = false
    void run.result.then(() => { settled = true })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('four')
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Error: Execution policy rules-a@1 denies tool \\"four\\"')
    expect(settled).toBe(false)
    expect(ledger.finishes).toEqual([])
    gate.resolve(undefined)
    await run.result
    expect(executed).toEqual([])
    const denied = ledger.events.findIndex(event => event.kind === 'policy/denied')
    expect(denied).toBeGreaterThan(-1)
    expect(ledger.events.findIndex(event => event.kind === 'run/end')).toBeGreaterThan(denied)
  })

  it('denies a dynamically registered fourth tool and an alias at the final guard', async () => {
    const { ctx, ledger, executed, register, request } = await setup(['hang'])
    const run = await startPreparedActivation(request)
    register(run.localAgent.ctx, 'dynamic-four')
    register(run.localAgent.ctx, 'alias-four')
    for (const name of ['dynamic-four', 'alias-four']) {
      const result = await ctx.tools.execute({
        agent: run.localAgent, name, callId: ToolCallId(name), arguments: {}, signal: request.signal,
      })
      expect(result.isError).toBe(true)
    }
    await run.dispose()
    expect(executed).toEqual([])
    expect(ledger.events.filter(event => event.kind === 'policy/denied')).toHaveLength(2)
  })

  it('denies a fourth capability reached through the PTC transport', async () => {
    const { ledger, executed, request } = await setup([
      toolCallResponse('code-a', 'run_code', { code: 'await tools.four({})', description: 'Try a fourth tool' }), textResponse('denied'),
    ], true)
    const run = await startPreparedActivation(request, { seed: [] })
    await run.result
    expect(executed).toEqual([])
    expect(ledger.events.some(event => event.kind === 'policy/denied' && event.requested === 'four')).toBe(true)
  })

  it('refuses a request-time model override before the adapter is dispatched', async () => {
    const { ctx, adapter, ledger, request } = await setup()
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), model: 'other-model' }))
    const run = await startPreparedActivation(request)
    expect((await run.result).stopReason).toBe('error')
    expect(adapter.requests).toEqual([])
    expect(ledger.events.some(event => event.kind === 'policy/denied' && event.operation === 'model')).toBe(true)
  })

  it('rejects a conflicting dispatch route before child execution', async () => {
    const { adapter, ledger, request } = await setup()
    await expect(startPreparedActivation({ ...request, agentOptions: { model: 'other-model' } })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(adapter.requests).toEqual([])
    expect(ledger.events.some(event => event.kind === 'policy/denied' && event.requested === 'other-model')).toBe(true)
    expect(ledger.finishes[0]).toMatchObject({ endReason: 'error' })
  })

  it('inherits identity and records the harness PID and active cancellation', async () => {
    const { adapter, ledger, request } = await setup(['hang'])
    const run = await startPreparedActivation(request)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await run.dispose()
    expect(ledger.starts[1]).toMatchObject({ seat: 'seat-a', window: 'window-a', taskId: 'task-a', identitySource: 'inherited', processIdentity: { pid: process.pid } })
    expect(ledger.finishes[0]).toMatchObject({ endReason: 'cancelled', upstreamStopReason: 'aborted' })
  })

  it('does not confirm settlement when a denied fact cannot be synchronized', async () => {
    const { ledger, request } = await setup([toolCallResponse('call-a', 'four', {}), textResponse('denied')])
    ledger.failDenied = true
    const run = await startPreparedActivation(request)
    await expect(run.result).rejects.toThrow('Subagent terminal accounting failed')
    expect(ledger.finishes).toEqual([])
  })

  it('refuses launch when run start synchronization fails', async () => {
    const { adapter, ledger, request } = await setup()
    ledger.failStart = true
    await expect(startPreparedActivation(request)).rejects.toThrow('Ledger synchronization failed')
    expect(adapter.requests).toEqual([])
  })
})
