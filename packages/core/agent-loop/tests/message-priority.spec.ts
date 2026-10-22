import { Context } from '@panedesk/cordis'
import type { Agent, AgentInputScheduler } from '@panedesk/dsh-agent'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import { defineContentToolFixture } from '@panedesk/dsh-tools'

function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness(script = [textResponse('reply'), textResponse('reply')]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('priority'), { provider: 'mock', model: 'model-a' }) as Agent & AgentInputScheduler
  return { ctx, driver, adapter, agent }
}

describe('scheduled input', () => {
  it.each(['queue', 'steer', 'immediate'] as const)('admits %s at its boundary during a long tool', async (priority) => {
    const { ctx, agent, adapter } = await harness([
      toolCallResponse('long-call', 'long_tool', {}), textResponse('continued'), textResponse('queued reply'),
    ])
    const started = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    ctx.tools.register(defineContentToolFixture({
      name: 'long_tool', description: 'A gated tool', parameters: {},
      async execute() {
        started.resolve(undefined)
        await released.promise
        return [{ type: 'text', text: 'partial result' }]
      },
    }))
    agent.followup(input('start'))
    await started.promise
    const message = input(priority)
    agent.enqueue(message, { priority, passive: false, wakeup: true })
    agent.enqueue(message, { priority, passive: false, wakeup: true })
    released.resolve(undefined)
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const endings = events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
    expect(endings).toEqual(priority === 'queue' ? ['completed', 'completed'] : priority === 'steer' ? ['completed'] : ['aborted', 'completed'])
    expect(adapter.requests[1]!.messages.some(item => item.id === message.id)).toBe(priority !== 'queue')
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    if (priority === 'immediate') {
      expect(results[0]!.data).toMatchObject({ cancellation: { cause: { kind: 'interjection' }, outcome: 'cancelled', sideEffects: 'unknown' } })
    }
  })

  it('orders both containers by priority and receipt sequence', async () => {
    const { agent, driver } = await harness()
    const messages = ['queue-a', 'queue-b', 'steer-a', 'steer-b', 'immediate'].map(input)
    for (const [index, message] of messages.entries()) {
      agent.enqueue(message, { priority: index < 2 ? 'queue' : index < 4 ? 'steer' : 'immediate', passive: false, wakeup: false })
    }
    const first = driver.claim(agent, 'next-turn', 1)
    const second = driver.claim(agent, 'next-turn', 2)
    expect([...first, ...second].map(message => message.id)).toEqual([
      messages[4]!.id, messages[2]!.id, messages[3]!.id, messages[0]!.id, messages[1]!.id,
    ])
  })

  it('parks passive input and batches it into the next natural turn', async () => {
    const { agent, adapter } = await harness()
    const notice = input('notice')
    agent.enqueue(notice, { priority: 'queue', passive: true, wakeup: true })
    await agent.whenIdle()
    expect(agent.hasRunnable).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    agent.followup(input('natural'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.some(message => message.id === notice.id)).toBe(true)
  })

  it('does not continue solely for a notice received during a turn', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.on('agent/request', (_payload, next) => {
      agent.enqueue(input('notice'), { priority: 'queue', passive: true, wakeup: false })
      return next()
    })
    agent.followup(input('natural'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.hasRunnable).toBe(false)
  })

  it('commits required scheduled facts before each scheduling-aware splice', async () => {
    const { agent } = await harness()
    agent.enqueue(input('pending'), { priority: 'steer', passive: false, wakeup: false })
    const events = agent.session.snapshotEvents()
    const index = events.findIndex(event => event.type === 'agent/inbox/spliced' && event.data.scheduling !== undefined)
    expect(events[index - 1]?.type).toBe('agent/input/transition')
    expect(events[index - 1]?.data).toMatchObject({ phase: 'scheduled' })
  })
})
