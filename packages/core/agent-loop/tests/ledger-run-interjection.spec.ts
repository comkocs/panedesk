import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MockAdapter } from './mock-adapter.ts'

it('settles an interjection-aborted residency as cancelled with interjection detail', async () => {
  const home = await mkdtemp(join(import.meta.dirname, '.ledger-interjection-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JournalSessionLedger, { dshHome: home })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
    const handle = await ctx.agents.create({ sessionId: SessionId('seat-a'), agentOptions: { provider: 'mock', model: 'model-a' } })
    const entered = Promise.withResolvers<undefined>()
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') entered.resolve(undefined) })
    try {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start' }] }))
      await entered.promise
      handle.agent.cancel({ kind: 'interjection' }, { keepInbox: true })
      await handle.agent.whenIdle()
    } finally { handle.agent.cancel({ kind: 'disposed' }); await handle.dispose() }
    const runs = (await ctx.sessionLedger.snapshot()).rows.filter(row => row.kind === 'run')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.finish).toMatchObject({ endReason: 'cancelled', upstreamStopReason: 'interjection' })
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
