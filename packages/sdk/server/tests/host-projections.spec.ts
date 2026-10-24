import { Context } from '@panedesk/cordis'
import type { AgentRegistry } from '@panedesk/dsh-agent'
import type { LlmRuntime } from '@panedesk/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function fixture() {
  const ctx = new Context()
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture' }], resolveCallConfig: async () => ({}) } as Partial<LlmRuntime> as LlmRuntime)
  const initiator = vi.fn<AgentRegistry['currentInitiator']>(() => undefined)
  ctx.provide('agents', { currentInitiator: initiator } as Partial<AgentRegistry> as AgentRegistry)
  const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
  return { ctx, server, initiator }
}

describe('SDK read-only host projections', () => {
  it('preserves dated health, unknown aliases and empty advancing pages', async () => {
    const f = await fixture()
    const cursor = { nodeId: 'node-a' as never, sequence: 4, effectIndex: 1 }
    const page = { facts: [], complete: false, watermark: 9, nextCursor: cursor, legacyAttribution: 'legacy-unknown' as const }
    const query = vi.fn(async () => page)
    const nodes = [{ nodeId: 'node-a' as never, nodeName: 'node-a', reachable: false, linkState: 'stale' as const,
      observedAt: '2026-01-01T00:00:00Z' as never, status: null, capabilities: [], safeReason: 'unavailable' }]
    f.ctx.provide('nodeRouter', { status: async () => nodes, route: vi.fn() })
    f.ctx.provide('seatAuthorizationQueries', { query, tasks: vi.fn() })
    try {
      await expect(f.server.handleRequest('nodes/list', {})).rejects.toMatchObject({ code: -32601 })
      expect(await f.server.initialize({ cwd: process.cwd(), provider: 'fixture', model: 'fixture' })).not.toHaveProperty('namespaces')
      expect(await f.server.handleRequest('nodes/list', {})).toEqual(nodes)
      expect(await f.server.handleRequest('nodes/status', { nodeId: 'node-b' })).toBeNull()
      const request = { taskId: 'task-a', seat: 'seat-a', nodeId: 'node-a', kind: 'human', limit: 2, cursor }
      expect(await f.server.handleRequest('authorizations/query', request)).toEqual(page)
      expect(query).toHaveBeenCalledExactlyOnceWith(request)
      for (const invalid of [{ limit: 1, principalId: 'owner' }, { limit: 0 }, { limit: 1, kind: 'owner' },
        { limit: 1, cursor: { ...cursor, sequence: -1 } }]) {
        await expect(f.server.handleRequest('authorizations/query', invalid)).rejects.toThrow()
      }
      expect(query).toHaveBeenCalledTimes(1)
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
  it('reports unsupported without providers and denies self-reported delegated attribution', async () => {
    const f = await fixture()
    try {
      await f.server.initialize({ cwd: process.cwd(), provider: 'fixture', model: 'fixture' })
      await expect(f.server.handleRequest('nodes/list', {})).rejects.toMatchObject({ data: { reason: 'unsupported' } })
      await expect(f.server.handleRequest('authorizations/query', { limit: 1 })).rejects.toMatchObject({ data: { reason: 'unsupported' } })
      const query = vi.fn()
      f.ctx.provide('seatAuthorizationQueries', { query, tasks: vi.fn() })
      f.initiator.mockReturnValue({ session: { id: 'session-a' } } as ReturnType<AgentRegistry['currentInitiator']>)
      await expect(f.server.handleRequest('authorizations/query', { limit: 1 })).rejects.toMatchObject({ data: { reason: 'unauthorized' } })
      expect(query).not.toHaveBeenCalled()
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
})
