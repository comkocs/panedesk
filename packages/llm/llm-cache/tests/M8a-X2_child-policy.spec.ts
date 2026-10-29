import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { Agent } from '@panedesk/dsh-agent'
import type { LedgerEventId, LedgerRunId } from '@panedesk/dsh-session-ledger'
import { harness } from './harness.ts'

const routes = [
  { provider: 'responses', modelFamily: 'openai', capability: 'openai-responses', retention: '12h', ttl: 43200 },
  { provider: 'deepseek', modelFamily: 'deepseek', capability: 'automatic', retention: 'auto', ttl: undefined },
  { provider: 'undeclared', modelFamily: 'undeclared', capability: 'unsupported', retention: 'default', ttl: undefined },
] as const

async function send(agent: Agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('child cache inheritance', () => {
  for (const route of routes) {
    it.each(['parent default', 'parent explicit', 'child override', 'recovery'] as const)
    (`${route.capability}: %s records the effective child retention`, async (scenario) => {
      const raw = scenario === 'parent default' ? 'default' : '5m'
      const { ctx, adapter, ledger } = await harness({ config: {
        policy: { retention: raw },
        routes: [{ provider: 'model-provider', modelFamily: 'anthropic', capability: 'anthropic' }, route],
      } })
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      adapter.chunks = [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { type: 'finish', reason: { kind: 'stop' }, cacheWriteTiering: { kind: 'untiered' } },
      ]
      ctx.llm.registerAdapter([route.provider], adapter)
      try {
        const parent = await ctx.agents.create({ sessionId: SessionId('parent-policy'),
          agentOptions: { provider: 'model-provider', model: 'model' } })
        await send(parent.agent)
        const parentPolicy = ledger?.starts.at(-1)?.cache.sessionPolicy?.retention
        const childId = SessionId('child-policy')
        if (scenario === 'recovery') {
          const start = ledger!.starts.at(-1)!
          ledger!.restored = { complete: true, asOf: Date.now(), watermarks: {}, rows: [{ kind: 'event', event: {
            schemaVersion: 1, eventId: 'parent-policy' as LedgerEventId, nodeId: start.nodeId,
            sessionId: parent.agent.id, runId: start.runId, observedAt: Date.now(), kind: 'cache/evidence',
            evidence: { cacheMode: 'explicit', breakReasons: [], sessionPolicy: { retention: raw } },
          } }] }
          const restored = ledger!.restored
          vi.spyOn(ledger!, 'snapshot').mockImplementation((request?: { sessionId?: SessionId }) => Promise.resolve(
            request?.sessionId === childId ? { complete: true, asOf: 0, watermarks: {}, rows: [] } : restored,
          ))
          ledger!.bindContext({ ...start, sessionId: childId, parentSessionId: parent.agent.id,
            runId: 'child-run' as LedgerRunId })
          await parent.dispose()
        }
        const override = scenario === 'child override'
        const child = await ctx.agents.create({ sessionId: childId,
          ...scenario === 'recovery' ? {} : { parentAgent: parent.agent },
          agentOptions: { provider: route.provider, model: 'model',
            ...override ? { cachePolicy: { retention: 'default' as const } } : {} } })
        await send(child.agent)
        await send(child.agent)
        const requests = adapter.requests.filter(request => request.provider === route.provider)
        expect(requests).toHaveLength(2)
        expect(parentPolicy).toBe(raw)
        expect(requests.map(request => request.cache?.retention)).toEqual([route.retention, route.retention])
        const starts = ledger!.starts.filter(start => start.provider === route.provider)
        expect(starts).toHaveLength(2)
        for (const start of starts) {
          expect(start.cache.retention?.retention).toBe(route.retention)
          expect(start.cache.ttlSeconds).toBe(route.ttl)
          expect(start.cache.sessionPolicy?.retention).toBe('default')
        }
        for (const end of ledger!.ends.filter(end => starts.some(start => start.callId === end.callId))) {
          expect(end.cache?.retention?.retention).toBe(route.retention)
          expect(end.cache?.ttlSeconds).toBe(route.ttl)
          expect(end.cacheWriteTiering).toEqual({ kind: 'untiered' })
          expect(end.usage).toMatchObject({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
        }
        const warnings = warn.mock.calls.filter(([message]) => String(message).startsWith('Inherited cache retention'))
        expect(warnings).toHaveLength(raw === '5m' && !override ? 1 : 0)
        if (warnings.length !== 0) expect(warnings[0]?.[0]).toBe(
          `Inherited cache retention 5m is unsupported for ${route.provider} (${route.capability}); using ${route.retention}`,
        )
        await child.dispose()
        if (scenario !== 'recovery') await parent.dispose()
      } finally { warn.mockRestore(); await ctx.fiber.dispose() }
    })

    it(`${route.capability}: rejects an invalid explicit child selection`, async () => {
      const { ctx, adapter } = await harness({ config: { routes: [route] } })
      ctx.llm.registerAdapter([route.provider], adapter)
      try {
        const child = await ctx.agents.create({ sessionId: SessionId('invalid-child'),
          agentOptions: { provider: route.provider, model: 'model', cachePolicy: { retention: '5m' } } })
        await expect(ctx.waterfall('agent/request', { agent: child.agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
          provider: route.provider, model: 'model', messages: [],
        }))).rejects.toThrow(`Unsupported cache retention 5m for ${route.provider}`)
        expect(adapter.requests).toHaveLength(0)
        await child.dispose()
      } finally { await ctx.fiber.dispose() }
    })
  }
})
