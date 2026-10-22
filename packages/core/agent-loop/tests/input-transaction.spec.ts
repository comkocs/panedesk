import { Context } from '@panedesk/cordis'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('reply'), textResponse('reply')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('transaction'), { provider: 'mock', model: 'model-a' })
  const message = createUserMessage({ content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } })
  return { ctx, agent, adapter, message }
}

describe('input transactions', () => {
  it('awaits preparation before reserving input and leaves it pending on failure', async () => {
    const { ctx, agent, message, adapter } = await harness()
    ctx.on('agent/input-preparing', () => {
      expect(agent.inbox.inputState?.(message.id)).toBe('queued')
      throw new Error('preparation failed')
    })
    agent.followup(message)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([message])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/input/transition' && event.data.phase === 'claimed')).toBe(false)
  })

  it('restores a cancelled reservation before append and permits removal', async () => {
    const { ctx, agent, message, adapter } = await harness()
    ctx.on('agent/request', (_payload, next) => {
      expect(agent.inbox.inputState?.(message.id)).toBe('claimed')
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return next()
    })
    agent.followup(message)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([message])
    expect(agent.inbox.inputState?.(message.id)).toBe('queued')
    expect(agent.inbox.remove(message.id)).toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })

  it('retains appended input after synchronous construction failure until the next dispatch', async () => {
    const { agent, message, adapter } = await harness()
    const derive = vi.spyOn(agent.session, 'deriveMessages').mockImplementationOnce(() => {
      throw new Error('request construction failed')
    })
    agent.followup(message)
    await agent.whenIdle()
    expect(agent.inbox.inputState?.(message.id)).toBe('claimed')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id)).toHaveLength(1)
    derive.mockRestore()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[0]!.messages.some(item => item.id === message.id)).toBe(true)
    expect(agent.inbox.inputState?.(message.id)).toBe('injected')
    const transitions = agent.session.snapshotEvents().flatMap(event => event.type === 'agent/input/transition'
      && event.data.messageIds.includes(message.id) ? [event.data.phase] : [])
    expect(transitions).toEqual(['claimed', 'appended', 'dispatched'])
  })
})
