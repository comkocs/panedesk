import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SeatEngineService, SeatService } from '@panedesk/dsh-seat'
import { makeBridgeHarness } from './harness.ts'

const methods = ['seats/open', 'seats/renew', 'seats/close', 'seats/replace', 'seats/wake', 'nodes/list', 'nodes/status', 'authorizations/query']
const offer = { protocolVersion: PROTOCOL_VERSION, _meta: { 'panedesk/host': { version: 1, methods: methods.map(method => `_panedesk/${method}`) } } }

describe('ACP opt-in host projections', () => {
  it('preserves node and operation identities through negotiated seat and query methods', async () => {
    const node = { nodeId: 'node-a' as never, nodeName: 'node-a', engine: 'running' as const,
      openEngineWindows: 0, limit: null, readyAt: null }
    const page = { facts: [], complete: false, watermark: 9, nextCursor: { nodeId: 'node-a' as never, sequence: 4, effectIndex: 1 }, legacyAttribution: 'legacy-unknown' as const }
    const open = vi.fn(async () => ({ status: 'cancelled' as const }))
    const renew = vi.fn(), close = vi.fn(), replace = vi.fn(), wake = vi.fn()
    const service = { open, renew, close, replace, wake } as Partial<SeatService> as SeatService
    const withAuthority = vi.fn(() => service)
    service.withAuthority = withAuthority
    const query = vi.fn(async () => page)
    const h = await makeBridgeHarness({ setup: async (ctx) => {
      ctx.provide('seats', service)
      ctx.provide('seatEngine', { nodeStatus: async () => node } as Partial<SeatEngineService> as SeatEngineService)
      ctx.provide('nodeRouter', { status: async () => [], route: vi.fn() })
      ctx.provide('seatAuthorizationQueries', { query, tasks: vi.fn() })
    } })
    try {
      const initialized = await h.client.initialize(offer)
      expect(initialized._meta).toEqual(offer._meta)
      const request = { seat: 'seat-a', nodeId: 'node-b', operationId: 'operation-a' }
      await expect(h.requestExtension('_panedesk/seats/open', request)).resolves.toEqual({ status: 'cancelled' })
      expect(open).toHaveBeenCalledExactlyOnceWith({ ...request, origin: 'remote', openingMode: 'auto' })
      expect(withAuthority).toHaveBeenCalledWith({ principalId: 'owner', origin: 'remote', nodeId: 'node-a' })
      for (const [method, provider] of [['renew', renew], ['replace', replace], ['wake', wake]] as const) {
        provider.mockResolvedValue({ status: 'cancelled' })
        const input = { sessionId: 'session-a', nodeId: 'node-b', operationId: `operation-${method}`,
          ...method === 'wake' ? { seat: 'seat-a' } : {} }
        await h.requestExtension(`_panedesk/seats/${method}`, input)
        expect(provider).toHaveBeenCalledExactlyOnceWith(input)
      }
      close.mockResolvedValue({ status: 'closed' })
      const closing = { sessionId: 'session-a', nodeId: 'node-b', operationId: 'operation-close', expectedStateVersion: 2 }
      await h.requestExtension('_panedesk/seats/close', closing)
      expect(close).toHaveBeenCalledExactlyOnceWith(closing)
      await expect(h.requestExtension('_panedesk/authorizations/query', { limit: 2, taskId: 'task-a' })).resolves.toEqual(page)
      expect(query).toHaveBeenCalledExactlyOnceWith({ limit: 2, taskId: 'task-a' })
      await expect(h.requestExtension('_panedesk/nodes/status', { nodeId: 'node-b' })).resolves.toBeNull()
      expect(h.adapter.requests).toEqual([])
    } finally { await h.dispose() }
  })
  it('leaves legacy initialization unchanged and rejects unnegotiated or absent providers', async () => {
    const h = await makeBridgeHarness()
    try {
      expect((await h.client.initialize({ protocolVersion: PROTOCOL_VERSION }))._meta).toBeUndefined()
      await expect(h.requestExtension('_panedesk/nodes/list', {})).rejects.toMatchObject({ code: -32601 })
      expect((await h.client.initialize(offer))._meta).toEqual({ 'panedesk/host': { version: 1, methods: [] } })
      await expect(h.requestExtension('_panedesk/seats/open', { seat: 'seat-a', operationId: 'operation-a' })).rejects.toMatchObject({ code: -32601 })
    } finally { await h.dispose() }
  })
})
