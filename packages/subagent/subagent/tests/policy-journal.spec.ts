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
import { defineTool } from '@panedesk/dsh-tools'
import { JournalSessionLedger, type LedgerRunId } from '@panedesk/dsh-session-ledger'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { restoreExecutionEvidence } from '../src/restoration.ts'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

it('inherits a durable parent run and restores the original policy from a reopened journal', async () => {
  const home = await mkdtemp(join(import.meta.dirname, '.policy-journal-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'controlled' })
  await ctx.plugin(JournalSessionLedger, { dshHome: home })
  const policy = { provider: 'mock', model: 'model-a', reasoningEffort: 'high', allowedTools: ['one', 'two', 'three'], rulesId: 'rules-a', version: '1', digest: 'rules-a' }
  await ctx.agentPresets.register({ id: 'controlled', plugins: [], executionPolicy: policy })
  for (const name of policy.allowedTools) ctx.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve(name) }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')],
    { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') }))
  const parent = (await ctx.agents.create({ sessionId: SessionId('parent-a'), agentOptions: { provider: 'mock', model: 'model-a' },
    setup: async (childCtx) => { await ctx.agentPresets.mount(childCtx, 'controlled') },
  })).agent
  await ctx.sessionLedger.beginRun({ sessionId: parent.id, rootSessionId: parent.id, runId: 'parent-run-a' as LedgerRunId,
    nodeId: await ctx.sessionLedger.nodeId(), seat: 'seat-a', window: 'window-a', taskId: 'task-a', identitySource: 'startup',
    accountLabel: 'unknown', startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
  expect(ctx.sessionLedger.contextFor(parent.id)).toBeUndefined()
  const activation = await startPreparedActivation({ parent, prompt: [{ type: 'text', text: 'work' }], signal: new AbortController().signal })
  await activation.result
  const snapshot = await ctx.sessionLedger.snapshot({ sessionId: activation.id })
  expect(snapshot.rows.find(row => row.kind === 'run')).toMatchObject({ kind: 'run', start: {
    parentRunId: 'parent-run-a', parentSessionId: 'parent-a', seat: 'seat-a', ...executionPolicyMetadata(policy),
  } })
  const reopenedContext = new Context()
  contexts.push(reopenedContext)
  await reopenedContext.plugin(JournalSessionLedger, { dshHome: home })
  expect(await restoreExecutionEvidence(reopenedContext, parent, activation.id, { ...policy, allowedTools: [...policy.allowedTools, 'four'] }))
    .toMatchObject({ executionPolicy: policy })
  expect((await reopenedContext.sessionLedger.snapshot()).rows.find(row => row.kind === 'event' && row.event.kind === 'alert'))
    .toMatchObject({ kind: 'event', event: { kind: 'alert', alert: { code: 'subagent-definition-changed' } } })
})
