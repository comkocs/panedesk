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
