/** Cache-owned Remote behavior under a real Gateway, cache plugin, and synthetic ledger. */
import { describe, expect, it } from 'vitest'
import Gateway from '@panedesk/dsh-api-gateway'
import Access from '@panedesk/dsh-api-remote-access'
import { Peer } from '@panedesk/dsh-client-connection'
import Registry from '@panedesk/dsh-typert-registry'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { PrincipalMap } from '@panedesk/dsh-typert-protocol'
import type { CacheRoute } from '../src/policy.ts'
import { harness } from './harness.ts'

declare module '@panedesk/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Caller restricted to explicitly selected cache session resources. */
    'cache-reader': { readonly kind: 'cache-reader' }
  }
}

const MAIN = SessionId('cache-main')
const CHILD = SessionId('cache-child')

async function setup(capability: CacheRoute['capability'] = 'anthropic', ledger = true) {
  const state = await harness({ ledger, config: { routes: [{ provider: 'model-provider', modelFamily: 'family-a', capability }] } })
  await state.ctx.plugin(Registry)
  await state.ctx.plugin(Access)
  await state.ctx.plugin(Gateway)
  const handle = await state.ctx.agents.create({ sessionId: MAIN, agentOptions: { provider: 'model-provider', model: 'model', cachePolicy: { retention: 'default', stableKey: 'stable' } } })
  return { ...state, handle, view: state.ctx.get('cacheView') }
}

describe('cache view Remote', () => {
  it.each([
    ['anthropic', ['none', '5m', '1h'], '1h'],
    ['openai-responses', ['none', '30m', '12h'], '12h'],
    ['openai-chat', ['none', '30m'], '30m'],
    ['automatic', [], 'auto'],
  ] as const)('derives %s tiers from the request policy resolver', async (capability, tiers, retention) => {
    const { ctx, view, handle, ledger } = await setup(capability)
    try {
      expect(view).toBeDefined()
      const result = await view!.read({ sessionId: MAIN })
      expect(result.tiers).toEqual(tiers)
      expect(result.retention).toBe(retention)
      expect(result.adjustable).toBe(tiers.length > 0)
      expect(result.rows).toEqual([{ sessionId: MAIN, role: 'main', kind: 'unknown' }])
      if (capability === 'automatic') {
        await expect(view!.setTier({ sessionId: MAIN, retention: '30m' })).rejects.toThrow('not supported')
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe automatic hits' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        const start = ledger!.starts[0]!
        const finish = ledger!.ends[0]!
        ledger!.restored = { asOf: Date.now(), watermarks: {}, complete: true, rows: [
          { kind: 'call', start, finish },
          { kind: 'call', start: { ...start, sessionId: CHILD, parentSessionId: MAIN }, finish },
        ] }
        const automatic = await view!.read({ sessionId: MAIN })
        expect(automatic.tiers).toEqual([])
        expect(automatic.rows).toEqual([
          { sessionId: MAIN, role: 'main', kind: 'automatic', cacheReadTokens: 20 },
          { sessionId: CHILD, role: 'subagent', kind: 'automatic', cacheReadTokens: 20 },
        ])
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves stable keys and the request already built while storing the next tier', async () => {
    const { ctx, handle, view, adapter } = await setup()
    try {
      const signal = new AbortController().signal
      const request = () => ctx.waterfall('agent/request', { agent: handle.agent, turn: 1, step: 1, signal }, async () => ({ provider: 'model-provider', model: 'model', messages: [] }))
      const first = await request()
      await view!.setTier({ sessionId: MAIN, retention: '5m' })
      const next = await request()
      expect(first.cache).toEqual({ retention: '1h', key: 'stable' })
      expect(next.cache).toEqual({ retention: '5m', key: 'stable' })
      expect(adapter.requests).toEqual([])
      await expect(view!.setTier({ sessionId: MAIN, retention: '12h' })).rejects.toThrow('not supported')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses controls without a ledger instead of claiming a passthrough request was changed', async () => {
    const { ctx, view } = await setup('anthropic', false)
    try {
      expect((await view!.read({ sessionId: MAIN })).tiers).toEqual([])
      await expect(view!.setTier({ sessionId: MAIN, retention: '5m' })).rejects.toThrow('unavailable')
    } finally { await ctx.fiber.dispose() }
  })

  it('filters ended descendants by the Gateway caller grants and recovers their ledger countdown', async () => {
    const { ctx, view, ledger, handle } = await setup()
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read cache' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const start = ledger!.starts[0]!
      const finish = ledger!.ends[0]!
      ledger!.restored = { asOf: Date.now(), watermarks: {}, complete: true, rows: [
        { kind: 'call', start, finish },
        { kind: 'call', start: { ...start, sessionId: CHILD, parentSessionId: MAIN }, finish },
      ] }
      const all = await view!.read({ sessionId: MAIN })
      expect(all.rows.map(row => row.sessionId)).toEqual([MAIN, CHILD])
      for (const row of all.rows) {
        expect(row.kind).toBe('estimated')
        if (row.kind === 'estimated') expect(Math.abs(row.seconds - 3600)).toBeLessThanOrEqual(5)
      }
      const principal: PrincipalMap['cache-reader'] = { kind: 'cache-reader' }
      ctx.remoteAccess.registerPolicy('cache-reader', { bindings: () => [{
        role: { name: 'cache:read', resource: 'session', actions: ['cacheView/read'] },
        resource: { kind: 'session', id: MAIN },
      }] })
      const peer = new Peer(ctx, { principal })
      const filtered = await ctx.typertGateway.invoke({ peer, namespace: 'cacheView', method: 'read', args: { request: { sessionId: MAIN } } })
      expect(filtered).toMatchObject({ rows: [{ sessionId: MAIN }] })
      await expect(ctx.typertGateway.invoke({ peer, namespace: 'cacheView', method: 'read', args: { request: { sessionId: CHILD } } })).rejects.toThrow()
      await expect(ctx.typertGateway.invoke({ peer, namespace: 'cacheView', method: 'setTier', args: { request: { sessionId: MAIN, retention: '5m' } } })).rejects.toThrow()
    } finally { await ctx.fiber.dispose() }
  })
})
