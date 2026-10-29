import { describe, expect, it } from 'vitest'
import type { InitializeParams } from '@panedesk/dsh-sdk-protocol'
import { Context } from '@panedesk/cordis'
import AgentPresets from '@panedesk/dsh-agent-preset-registry'
import Loader from '@panedesk/cordis-plugin-loader'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import { executionPolicyDigest, validateHandshake } from '../src/handshake.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'
import { SessionId } from '@panedesk/dsh-session'
import { harness } from '../../../llm/llm-cache/tests/harness.ts'

const legacy = { cwd: '/workspace', provider: 'mock', model: 'mock' }

describe('optional SDK handshake validation', () => {
  it('canonicalizes keys but preserves array order and the internal rules digest', () => {
    expect(executionPolicyDigest({ b: 2, a: { y: 1, x: 0 } })).toBe(executionPolicyDigest({ a: { x: 0, y: 1 }, b: 2 }))
    expect(executionPolicyDigest({ tools: ['a', 'b'] })).not.toBe(executionPolicyDigest({ tools: ['b', 'a'] }))
    expect(executionPolicyDigest({ digest: 'one' })).not.toBe(executionPolicyDigest({ digest: 'two' }))
  })

  it.each(['version', 'digest', 'model'] as const)('rejects an installed policy %s mismatch before adapter resolution', async (field) => {
    const policy = { provider: 'mock', model: 'mock', reasoningEffort: 'high', allowedTools: [], rulesId: 'rules', version: '1', digest: 'rules-digest' }
    const digest = executionPolicyDigest(policy)
    const ctx = new Context()
    await ctx.plugin(Loader)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentPresets, { default: 'worker' })
    await ctx.agentPresets.register({ id: 'worker', plugins: [], executionPolicy: policy })
    const server = new HarnessSdkJsonRpcServer(ctx, { notify: () => {}, request: async () => ({}) })
    await expect(server.initialize({ ...legacy, model: field === 'model' ? 'other' : 'mock',
      reasoningEffort: ReasoningEffortId('high'), agentPreset: 'worker', executionPolicy: {
        presetId: 'worker', version: field === 'version' ? '2' : '1', digest: field === 'digest' ? 'b'.repeat(64) : digest,
      },
    })).rejects.toThrow(field === 'model' ? 'route does not match' : 'version or digest mismatch')
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('accepts legacy clients and a complete new handshake', () => {
    expect(() => { validateHandshake(legacy) }).not.toThrow()
    expect(() => { validateHandshake({ ...legacy, agentPreset: 'worker',
      executionPolicy: { presetId: 'worker', version: '1', digest: 'a'.repeat(64) },
      ledgerContext: { seat: 'seat', window: 'window', nodeId: 'node', identitySource: 'inherited',
        parentSessionId: 'parent', rootSessionId: 'root', subagentRunId: 'run', parentRunId: 'parent-run', childSessionId: 'child' },
      cachePolicy: { retention: '1h' },
    }) }).not.toThrow()
  })

  it('preserves legacy client request cache controls without an inheritance marker', async () => {
    const cachePolicies = [
      undefined,
      { retention: 'default' as const },
      { retention: 'none' as const },
      { retention: '5m' as const, key: 'legacy-cache-key' },
      { retention: '1h' as const },
    ]
    for (const [index, cachePolicy] of cachePolicies.entries()) {
      const { ctx, adapter } = await harness()
      const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
      try {
        await server.initialize({ cwd: process.cwd(), provider: 'model-provider', model: 'model-a',
          ...cachePolicy === undefined ? {} : { cachePolicy } })
        const sessionId = `legacy-cache-${index}`
        await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Continue' }] })
        await ctx.agents.get(SessionId(sessionId))!.whenIdle()
        expect(adapter.requests).toHaveLength(1)
        expect(adapter.requests[0]!.cache).toEqual({
          retention: cachePolicy === undefined || cachePolicy.retention === 'default' ? '1h' : cachePolicy.retention,
          key: cachePolicy !== undefined && 'key' in cachePolicy ? cachePolicy.key : sessionId,
        })
      } finally {
        await server.shutdown()
        await ctx.fiber.dispose()
      }
    }
  })

  it.each([undefined, false] as const)('rejects explicit unsupported cache retention with inheritance marker %s', async (inherited) => {
    const { ctx, adapter } = await harness({ config: { routes: [
      { provider: 'responses', modelFamily: 'openai', capability: 'openai-responses' },
    ] } })
    ctx.llm.registerAdapter(['responses'], adapter)
    const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
    try {
      await server.initialize({ cwd: process.cwd(), provider: 'responses', model: 'model',
        cachePolicy: { retention: '5m' }, ...inherited === undefined ? {} : { cachePolicyInherited: inherited } })
      await server.prompt({ sessionId: 'invalid-explicit-cache', contentBlocks: [{ type: 'text', text: 'Continue' }] })
      await server.wait({ sessionId: 'invalid-explicit-cache' })
      const agent = ctx.agents.get(SessionId('invalid-explicit-cache'))!
      await expect(ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
        provider: 'responses', model: 'model', messages: [],
      }))).rejects.toThrow(new Error('Unsupported cache retention 5m for responses'))
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { agentPreset: '' },
    { agentPreset: 'worker', executionPolicy: { presetId: 'other', version: '1', digest: 'a'.repeat(64) } },
    { agentPreset: 'worker', executionPolicy: { presetId: 'worker', version: '1', digest: 'bad' } },
    { ledgerContext: { seat: 'seat' } },
    { cachePolicy: { retention: 'forever' } },
    { cachePolicyInherited: true },
    { cachePolicy: { retention: '5m' }, cachePolicyInherited: 'true' },
  ])('rejects malformed optional fields before composition: %j', (fields) => {
    expect(() => { validateHandshake({ ...legacy, ...fields } as InitializeParams) }).toThrow()
  })
})
