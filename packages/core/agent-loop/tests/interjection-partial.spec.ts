import { Context } from '@panedesk/cordis'
import type { Agent, AgentInputScheduler } from '@panedesk/dsh-agent'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@panedesk/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await driver.create(SessionId('seat-a'), { provider: 'mock', model: 'model-a' }) as Agent & AgentInputScheduler
  return { ctx, agent }
}

describe('partial output on cancellation', () => {
  it.each(['interjection', 'user'] as const)('retains two received text chunks and replays them after %s', async (cause) => {
    const adapter = new MockAdapter([{
      hangAfter: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first ' },
        { type: 'text-delta', index: 0, text: 'second' },
      ],
    }, textResponse('continued')])
    const { ctx, agent } = await harness(adapter)
    const received = Promise.withResolvers<undefined>()
    const stop = ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta' && frame.chunk.text === 'second') {
        received.resolve(undefined)
      }
    })
    agent.followup(input('start'))
    await received.promise
    stop()
    if (cause === 'interjection') {
      agent.enqueue(input('continue'), { priority: 'immediate', passive: false, wakeup: true })
    } else {
      agent.cancel({ kind: 'user' })
    }
    await agent.whenIdle()
    const partial = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(partial?.data).toMatchObject({
      interrupted: true,
      message: { content: [{ type: 'text', text: 'first second' }] },
    })
    if (partial?.type !== 'assistant/message') throw new Error('Missing partial assistant message')
    if (cause === 'interjection') {
      expect(partial.data.interruptionReason).toBe('interjection')
    } else {
      expect(partial.data).not.toHaveProperty('interruptionReason')
      expect(adapter.requests).toHaveLength(1)
      agent.followup(input('continue'))
      await agent.whenIdle()
    }
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages).toContainEqual(partial.data.message)
  })

  it.each(['interjection', 'user'] as const)('does not fabricate text when %s precedes the first text delta', async (cause) => {
    const adapter = new MockAdapter([{
      hangAfter: [{ type: 'block-start', index: 0, blockType: 'text' }],
    }, textResponse('continued')])
    const { ctx, agent } = await harness(adapter)
    const started = Promise.withResolvers<undefined>()
    const stop = ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'chunk' && frame.chunk.type === 'block-start') started.resolve(undefined)
    })
    agent.followup(input('start'))
    await started.promise
    stop()
    if (cause === 'interjection') {
      agent.enqueue(input('continue'), { priority: 'immediate', passive: false, wakeup: true })
    } else {
      agent.cancel({ kind: 'user' })
    }
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/message' && event.data.turn === 1)).toEqual([])
  })

  it.each(['interjection', 'user'] as const)('settles a started tool with available output after %s', async (cause) => {
    const adapter = new MockAdapter([
      toolCallResponse('call-a', 'long_tool', {}), textResponse('continued'),
    ])
    const { ctx, agent } = await harness(adapter)
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
    if (cause === 'interjection') {
      agent.enqueue(input('continue'), { priority: 'immediate', passive: false, wakeup: true })
    } else {
      agent.cancel({ kind: 'user' })
    }
    released.resolve(undefined)
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]!.data
    if (cause === 'interjection') {
      expect(result).toMatchObject({
        cancellation: { cause: { kind: 'interjection' }, outcome: 'cancelled', sideEffects: 'unknown' },
        message: { content: [{ type: 'text', text: 'partial result' }], isError: true },
      })
      expect(adapter.requests[1]!.messages.some(message => JSON.stringify(message).includes('partial result'))).toBe(true)
    } else {
      expect(result).not.toHaveProperty('cancellation')
      expect(JSON.stringify(result)).not.toContain('partial result')
      expect(JSON.stringify(result)).toContain('Error: tool call aborted')
      expect(adapter.requests).toHaveLength(1)
    }
  })
})
