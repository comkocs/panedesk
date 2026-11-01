/**
 * One real in-process child, with an explicit cache policy, must appear on the
 * parent session's cache panel with a remaining-time reading taken from the
 * child's own call.
 *
 * The panel reads an unfiltered ledger snapshot. A run row whose parent points
 * at the main session lists the child; the countdown comes from that child's
 * own call evidence, never from the parent's. This spec uses the production
 * journal so the rows are the ones the child activation and the model call
 * actually wrote.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import AgentLoop from '@panedesk/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import Gateway from '@panedesk/dsh-api-gateway'
import Access from '@panedesk/dsh-api-remote-access'
import { SessionId } from '@panedesk/dsh-session'
import * as JsonlSessionPersistence from '@panedesk/dsh-session-persistence-jsonl'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import SubagentRuntime from '@panedesk/dsh-subagent'
import * as SpawnInProcess from '@panedesk/dsh-subagent-spawn-in-process'
import Registry from '@panedesk/dsh-typert-registry'
import { createUserMessage } from '@panedesk/dsh-llm'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolSubagent from '@panedesk/dsh-tool-subagent'
import * as Cache from '../src/index.ts'
import { foldCacheState, cacheRemaining } from '../src/state.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const hit = [
  { type: 'block-start' as const, index: 0, blockType: 'text' as const },
  { type: 'text-delta' as const, index: 0, text: 'child answer' },
  { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'child answer' } },
  { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 } },
  { type: 'finish' as const, reason: { kind: 'stop' as const }, cacheRetention: '1h' as const, cacheWriteTiering: { kind: 'untiered' as const } },
]

describe('cache panel rows for an in-process child', () => {
  it('lists the child started by the subagent tool and its remaining time', async () => {
    await runChild()
  })
})

async function runChild(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'cache-view-child-'))
  roots.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  await ctx.plugin(JournalSessionLedger, { dshHome: home })
  await ctx.plugin(Cache, {
    policy: { retention: '1h', stableKey: 'suite' },
    keepalive: { enabled: false, leadSeconds: 240, minimumIntervalSeconds: 60, maxOutputTokens: 1 },
    concurrency: [{ modelFamily: 'family-a', maxInFlight: 2 }],
    routes: [{ provider: 'mock', modelFamily: 'family-a', capability: 'anthropic' }],
  })
  await ctx.plugin(SubagentRuntime, {})
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Registry)
  await ctx.plugin(Access)
  await ctx.plugin(Gateway)
  const adapter = new MockAdapter([
    toolCallResponse('tool-child', 'subagent', { description: 'cache child', prompt: 'answer once' }),
    hit,
    hit,
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agents.create({
    sessionId: SessionId('cache-parent'), meta: { cwd: home },
    agentOptions: { provider: 'mock', model: 'model-a', cachePolicy: { retention: '1h', stableKey: 'stable' } },
  })
  parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent turn' }], source: { kind: 'user' } }))
  await parent.agent.whenIdle()
  try {
    const result = parent.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    const text = result?.type === 'tool/result'
      ? result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : ''
    const childId = SessionId(/started subagent (\S+)/.exec(text)?.[1] ?? '')
    expect(childId).not.toBe('')
    const deadline = Date.now() + 4_000
    let settled = false
    while (!settled && Date.now() < deadline) {
      const current = await ctx.sessionLedger.snapshot()
      settled = current.rows.some(row => row.kind === 'call' && row.start.sessionId === childId && row.finish !== undefined)
      if (!settled) await new Promise((resolve) => { setTimeout(resolve, 15) })
    }
    expect(settled).toBe(true)
    const now = Date.now()
    const snapshot = await ctx.sessionLedger.snapshot()
    const childRows = snapshot.rows.filter(row => row.kind !== 'event' && row.start.sessionId === childId)
    const childCall = childRows.find(row => row.kind === 'call')
    const expected = cacheRemaining(foldCacheState({ ...snapshot, rows: snapshot.rows.filter(row =>
      (row.kind === 'event' ? row.event.sessionId : row.start.sessionId) === childId) }), now)
    const view = await ctx.cacheView.read({ sessionId: parent.agent.id })
    const child = view.rows.find(row => row.sessionId === childId)
    expect(childRows.some(row => row.kind === 'run' && row.start.parentSessionId === parent.agent.id)).toBe(true)
    expect(childCall?.kind === 'call' ? childCall.start.parentSessionId : undefined).toBe(parent.agent.id)
    expect(child).toMatchObject({ role: 'subagent', kind: 'estimated' })
    if (child?.kind === 'estimated' && expected.kind === 'estimated') {
      expect(Math.abs(child.seconds - expected.seconds)).toBeLessThanOrEqual(5)
    } else {
      expect(expected.kind).toBe('estimated')
    }
  } finally {
    /* the spawn provider stays registered for the context's own disposal */
  }
}
