/** Turn admission leaves running work intact and deferred inbox work unclaimed. */
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { expect, it } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

it('finishes the current turn, defers the next without losing inbox work, and resumes on wake', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
  ctx.llm.registerAdapter(['mock'], adapter)
  let defer = false
  ctx.on('agent/turn-admitting', (_payload, next) => defer ? { kind: 'defer', reason: 'budget' } : next())
  const handle = await ctx.agents.create({ sessionId: SessionId('window-a'), agentOptions: { provider: 'mock', model: 'model-a' } })
  const agent = handle.agent
  const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  try {
    // Changing admission after turn/start cannot interrupt the admitted turn.
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/start') defer = true
    })
    agent.followup(message('first'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    agent.followup(message('second'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    defer = false
    agent.wake?.()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
  } finally { await ctx.fiber.dispose() }
})
