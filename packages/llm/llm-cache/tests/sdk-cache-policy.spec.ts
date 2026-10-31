import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkJsonRpcServer } from '../../../sdk/server/src/server.ts'
import * as JsonlPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { harness } from './harness.ts'

const routes = [
  { provider: 'responses', modelFamily: 'openai', capability: 'openai-responses', expected: '12h', ttl: 43200 },
  { provider: 'deepseek', modelFamily: 'deepseek', capability: 'automatic', expected: 'auto', ttl: undefined },
  { provider: 'undeclared', modelFamily: 'undeclared', capability: 'unsupported', expected: 'default', ttl: undefined },
] as const

describe('SDK child cache capability resolution', () => {
  for (const route of routes) {
    it.each(['parent default', 'parent explicit', 'child override', 'recovery'] as const)
    (`${route.capability}: %s records effective controls through the server`, async (scenario) => {
      const storage = scenario === 'recovery'
        ? await mkdtemp(join(import.meta.dirname, '.sdk-cache-resume-')) : undefined
      const { ctx, adapter, ledger } = await harness({ config: { routes: [route] } })
      if (storage !== undefined) await ctx.plugin(JsonlPersistence, { root: storage, compression: 'none' })
      ctx.llm.registerAdapter([route.provider], adapter)
      adapter.chunks = [
        { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { type: 'finish', reason: { kind: 'stop' }, cacheWriteTiering: { kind: 'untiered' } },
      ]
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      let server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
      const raw = scenario === 'parent explicit' || scenario === 'recovery' ? '5m' : 'default'
      try {
        await server.initialize({ cwd: process.cwd(), provider: route.provider, model: 'model',
          cachePolicy: { retention: raw }, cachePolicyInherited: scenario !== 'child override' })
        for (let index = 0; index < 2; index++) {
          await server.prompt({ sessionId: 'sdk-child', contentBlocks: [{ type: 'text', text: 'Continue' }] })
          await ctx.agents.get(SessionId('sdk-child'))!.whenIdle()
          if (scenario === 'recovery' && index === 0) {
            const start = ledger!.starts[0]!
            const finish = ledger!.ends[0]!
            ledger!.restored = { complete: true, asOf: Date.now(), watermarks: {},
              rows: [{ kind: 'call', start, finish }] }
            await server.shutdown()
            server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
            await server.initialize({ cwd: process.cwd(), provider: route.provider, model: 'model',
              cachePolicy: { retention: raw }, cachePolicyInherited: true })
            await server.resume({ sessionId: 'sdk-child' })
          }
        }
        expect(adapter.requests).toHaveLength(2)
        expect(adapter.requests.map(request => request.cache?.retention)).toEqual([route.expected, route.expected])
        expect(ledger!.starts).toHaveLength(2)
        for (const start of ledger!.starts) {
          expect(start.cache.retention?.retention).toBe(route.expected)
          expect(start.cache.ttlSeconds).toBe(route.ttl)
          expect(start.cache.sessionPolicy?.retention).toBe('default')
        }
        for (const end of ledger!.ends) {
          expect(end.cache?.retention?.retention).toBe(route.expected)
          expect(end.cache?.ttlSeconds).toBe(route.ttl)
          expect(end.cacheWriteTiering).toEqual({ kind: 'untiered' })
          expect(end.usage).toMatchObject({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
        }
        expect(warn.mock.calls.filter(([message]) => String(message).startsWith('Inherited cache retention')))
          .toHaveLength(raw === '5m' ? 1 : 0)
      } finally {
        await server.shutdown()
        warn.mockRestore()
        await ctx.fiber.dispose()
        if (storage !== undefined) await rm(storage, { recursive: true, force: true })
      }
    })

    it(`${route.capability}: rejects an explicit unsupported SDK child override`, async () => {
      const { ctx, adapter } = await harness({ config: { routes: [route] } })
      ctx.llm.registerAdapter([route.provider], adapter)
      const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
      try {
        await server.initialize({ cwd: process.cwd(), provider: route.provider, model: 'model',
          cachePolicy: { retention: '5m' }, cachePolicyInherited: false })
        await server.prompt({ sessionId: 'invalid-sdk-child', contentBlocks: [{ type: 'text', text: 'Continue' }] })
        await server.wait({ sessionId: 'invalid-sdk-child' })
        const child = ctx.agents.get(SessionId('invalid-sdk-child'))!
        await expect(ctx.waterfall('agent/request', { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
          provider: route.provider, model: 'model', messages: [],
        }))).rejects.toThrow(`Unsupported cache retention 5m for ${route.provider}`)
        expect(adapter.requests).toHaveLength(0)
      } finally { await server.shutdown(); await ctx.fiber.dispose() }
    })
  }
})
