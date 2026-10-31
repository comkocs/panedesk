import { describe, expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { Agent } from '@panedesk/dsh-agent'
import { Config } from '../src/index.ts'
import { harness } from './harness.ts'

async function send(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('route retention selection', () => {
  it('serves the route-pinned tier for default selections', async () => {
    const { ctx, adapter, ledger } = await harness({ config: { routes: [
      { provider: 'model-provider', modelFamily: 'family-a', capability: 'anthropic', retention: '5m' }] } })
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('route-pinned'),
        agentOptions: { provider: 'model-provider', model: 'model' } })
      await send(handle.agent)
      expect(adapter.requests.at(-1)?.cache).toEqual({ retention: '5m', key: SessionId('route-pinned') })
      expect(ledger?.starts.at(-1)?.cache.ttlSeconds).toBe(300)
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps unconfigured route requests byte-identical to the capability default', async () => {
    const { ctx, adapter } = await harness()
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('route-default'),
        agentOptions: { provider: 'model-provider', model: 'model' } })
      await send(handle.agent)
      expect(JSON.stringify(adapter.requests.at(-1)?.cache)).toBe(JSON.stringify({ retention: '1h', key: SessionId('route-default') }))
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('judges an updated explicit selection against the route of the request that carries it', async () => {
    const { ctx, adapter } = await harness({ config: { routes: [
      { provider: 'old-provider', modelFamily: 'family-old', capability: 'automatic' },
      { provider: 'model-provider', modelFamily: 'family-a', capability: 'anthropic' }] } })
    ctx.llm.registerAdapter(['old-provider'], adapter)
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('switched-route'),
        agentOptions: { provider: 'old-provider', model: 'model' } })
      await send(handle.agent)
      expect(adapter.requests.at(-1)?.provider).toBe('old-provider')
      await expect(ctx.llmCache.update({ agent: handle.agent, policy: { retention: '5m' } })).resolves.toBeUndefined()
      const signal = new AbortController().signal
      const request = await ctx.waterfall('agent/request', { agent: handle.agent, turn: 2, step: 1, signal }, async () => ({
        provider: 'model-provider', model: 'model', messages: [],
      }))
      expect(request.cache?.retention).toBe('5m')
      await expect(ctx.waterfall('agent/request', { agent: handle.agent, turn: 3, step: 1, signal }, async () => ({
        provider: 'old-provider', model: 'model', messages: [],
      }))).rejects.toThrow('Unsupported cache retention 5m for old-provider')
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('accepts a per-route retention in the plugin schema and rejects unknown tiers', () => {
    const config = Config({ policy: { retention: 'default' }, keepalive: {}, routes: [
      { provider: 'model-provider', modelFamily: 'family-a', capability: 'anthropic', retention: '5m' }] })
    expect(config.routes?.[0]?.retention).toBe('5m')
    expect(() => Config({ policy: { retention: 'default' }, keepalive: {}, routes: [
      { provider: 'model-provider', modelFamily: 'family-a', capability: 'anthropic', retention: '2h' as never }] })).toThrow()
  })
})
