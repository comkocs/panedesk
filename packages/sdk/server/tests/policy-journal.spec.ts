import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import AgentPresets, { executionPolicyMetadata } from '@panedesk/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import { defineTool } from '@panedesk/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

it.each(['inherited', 'startup'] as const)('mounts a controlled SDK preset and commits a fourth-tool denial with %s journal identity', async (identitySource) => {
  const home = await mkdtemp(join(import.meta.dirname, '.policy-journal-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'controlled' })
  await ctx.plugin(JournalSessionLedger, { dshHome: home })
  const policy = { provider: 'mock', model: 'model-a', reasoningEffort: 'high', allowedTools: ['one', 'two', 'three'], rulesId: 'rules-a', version: '1', digest: 'rules-a' }
  await ctx.agentPresets.register({ id: 'controlled', plugins: [], executionPolicy: policy })
  let executed = false
  for (const name of ['one', 'two', 'three', 'four']) ctx.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { executed = true; return Promise.resolve('four') },
  }))
  const adapter = new MockAdapter([toolCallResponse('call-a', 'four', {}), textResponse('done')],
    { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') })
  ctx.llm.registerAdapter(['mock'], adapter)
  const server = new HarnessSdkJsonRpcServer(ctx, { notify: () => {}, request: async () => ({}) })
  try {
    await server.initialize({ cwd: home, provider: policy.provider, model: policy.model, reasoningEffort: ReasoningEffortId('high'),
      agentPreset: 'controlled', executionPolicy: { presetId: 'controlled', version: '1', digest: executionPolicyMetadata(policy).executionPolicyDigest },
      ledgerContext: { seat: 'seat-a', window: 'window-a', taskId: 'task-a', nodeId: await ctx.sessionLedger.nodeId(), identitySource,
        parentSessionId: 'parent-a', rootSessionId: 'root-a', subagentRunId: 'run-a', parentRunId: 'parent-run-a', childSessionId: 'child-a' },
    })
    await server.prompt({ sessionId: 'child-a', contentBlocks: [{ type: 'text', text: 'Try the fourth tool' }] })
    await ctx.agents.get(SessionId('child-a'))!.whenIdle()
    expect(executed).toBe(false)
    expect(adapter.requests[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'high' })
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Denied by the installed execution policy')
    expect(ctx.sessionLedger.contextFor(SessionId('child-a'))).toMatchObject({ seat: 'seat-a', identitySource, parentRunId: 'parent-run-a', runId: 'run-a' })
    const reopenedContext = new Context()
    contexts.push(reopenedContext)
    const reopened = new JournalSessionLedger(reopenedContext, { dshHome: home })
    expect((await reopened.snapshot()).rows.find(row => row.kind === 'event' && row.event.kind === 'policy/denied'))
      .toMatchObject({ kind: 'event', event: {
        kind: 'policy/denied', operation: 'tool', requested: 'four', runId: 'run-a', sessionId: 'child-a',
      } })
  } finally { await server.shutdown() }
})
