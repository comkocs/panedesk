import { describe, expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage, ToolCallId } from '@panedesk/dsh-llm'
import * as TimeContext from '@panedesk/dsh-time-context'
import { fingerprintPrefix } from '../src/fingerprint.ts'
import { harness } from './harness.ts'

describe('stable prefix', () => {
  it('canonicalizes object keys and tool order while preserving array order and exact system bytes', () => {
    const a = { name: 'a', description: 'A', parameters: { type: 'object', required: ['x', 'y'] } }
    const b = { name: 'b', description: 'B', parameters: {} }
    expect(fingerprintPrefix('stable', [a, b])).toBe(fingerprintPrefix('stable', [b, { ...a, parameters: { required: ['x', 'y'], type: 'object' } }]))
    expect(fingerprintPrefix('stable ', [a])).not.toBe(fingerprintPrefix('stable', [a]))
    expect(fingerprintPrefix('stable', [{ ...a, parameters: { required: ['y', 'x'], type: 'object' } }])).not.toBe(fingerprintPrefix('stable', [a]))
    expect(() => fingerprintPrefix('stable', [{ ...a, parameters: { invalid: undefined } }])).toThrow('lossless JSON')
  })

  it('applies explicit runtime policy updates ahead of old headers and inherits them in children', async () => {
    const { ctx, adapter } = await harness()
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('policy-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      const send = async () => {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      await send()
      expect(adapter.requests.at(-1)?.cache?.retention).toBe('1h')
      await ctx.serial('llm-cache/update', { agent: handle.agent, policy: { retention: '5m' } })
      await send()
      expect(adapter.requests.at(-1)?.cache?.retention).toBe('5m')
      const child = await handle.agent.ctx.agents.create({ sessionId: SessionId('policy-child'), parentAgent: handle.agent,
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      child.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await child.agent.whenIdle()
      expect(adapter.requests.at(-1)?.cache?.retention).toBe('5m')
      await child.dispose()
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves prompt and request behavior unchanged when the ledger is absent', async () => {
    const { ctx, adapter } = await harness({ ledger: false })
    try {
      let text = 'First'
      ctx.systemPrompt.section({ name: 'stable', order: 0, text: () => text })
      const handle = await ctx.agents.create({ sessionId: SessionId('unmetered-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      for (const value of ['First', 'Second']) {
        text = value
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      expect(adapter.requests.every(request => request.cache === undefined)).toBe(true)
      expect(adapter.requests[1].messages[0]).toMatchObject({ content: [{ text: 'Second' }] })
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps ten requests stable across tools, an interjection, time snapshots, and deferred plugin changes', async () => {
    const { ctx, adapter, ledger } = await harness()
    try {
      await ctx.plugin(TimeContext, { refreshIntervalMs: 0 })
      let prompt = 'Stable system'
      ctx.systemPrompt.section({ name: 'stable', order: 0, text: () => prompt })
      let tools = [{ name: 'tool-a', description: 'Tool A', parameters: { type: 'object' } }]
      ctx.systemPrompt.tools(() => ({ schemas: tools }))
      const handle = await ctx.agents.create({ sessionId: SessionId('prefix-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      const normal = [...adapter.chunks]
      adapter.chunks = [
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('tool-1'), name: 'tool-a', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
      let count = 0
      ctx.on('llm/stream', (_request, next) => {
        count += 1
        if (count === 2) adapter.chunks = normal
        if (count === 4) handle.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Interjection' }], source: { kind: 'user' } }))
        return next()
      })
      while (count < 10) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        prompt = 'Changed plugin prompt'
        tools = [...tools, { name: `new-${count}`, description: 'Deferred', parameters: { type: 'object' } }]
      }
      expect(adapter.requests).toHaveLength(10)
      expect(new Set(ledger?.starts.map(start => start.cache.prefixFingerprint)).size).toBe(1)
      expect(ledger?.starts.some(start => start.cache.breakReasons.includes('interjection'))).toBe(true)
      for (const request of adapter.requests) {
        expect(request.messages[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'Stable system' }] })
        expect(request.tools?.map(tool => tool.name)).toEqual(['tool-a'])
        expect(JSON.stringify(request.messages[0])).not.toContain('Time sampled')
        expect(request.messages.some(message => JSON.stringify(message).includes('Time sampled'))).toBe(true)
      }
      tools = []
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(ledger?.starts.at(-1)?.cache.breakReasons).toContain('permission-change')
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })
})
