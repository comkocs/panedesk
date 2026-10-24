import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import { executeSeatCommand } from '../src/cli.ts'

describe('host CLI projections', () => {
  it('prints provider health and preserves an advancing empty authorization page', async () => {
    const ctx = new Context()
    const cursor = { nodeId: 'node-a' as never, sequence: 4, effectIndex: 1 }
    const page = { facts: [], complete: false, watermark: 9, nextCursor: cursor, legacyAttribution: 'legacy-unknown' as const }
    const query = vi.fn(async () => page)
    const nodes = [{ nodeId: 'node-a' as never, nodeName: 'node-a', reachable: false, linkState: 'stale' as const,
      observedAt: '2026-01-01T00:00:00Z' as never, status: null, capabilities: [], safeReason: 'unavailable' }]
    ctx.provide('nodeRouter', { status: async () => nodes, route: vi.fn() })
    ctx.provide('seatAuthorizationQueries', { query, tasks: vi.fn() })
    try {
      expect(await executeSeatCommand(ctx, ['nodes', 'list', '--json'])).toEqual({ code: 0, output: nodes })
      expect(await executeSeatCommand(ctx, ['nodes', 'status', '--node', 'node-b'])).toEqual({ code: 0, output: null })
      expect(await executeSeatCommand(ctx, ['authorizations', 'query', '--task', 'task-a', '--limit', '3', '--cursor', JSON.stringify(cursor)]))
        .toEqual({ code: 0, output: page })
      expect(query).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-a', limit: 3, cursor })
      expect((await executeSeatCommand(ctx, ['authorizations', 'query', '--request', '{"limit":1,"principalId":"owner"}'])).code).toBe(2)
      expect(query).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })
  it('reports unavailable providers without activating a host', async () => {
    const ctx = new Context()
    try { expect((await executeSeatCommand(ctx, ['nodes', 'list'])).code).toBe(2) }
    finally { await ctx.fiber.dispose() }
  })
})
