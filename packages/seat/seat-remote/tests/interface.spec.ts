import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SeatService, SeatEngineService } from '@panedesk/dsh-seat'
import SeatRemote from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const open = vi.fn(async () => ({ status: 'cancelled' as const }))
  const openBatch = vi.fn(async () => ({ status: 'processed' as const, results: [] }))
  const withAuthority = vi.fn((): SeatService => service)
  const service = { open, openBatch, withAuthority } as Partial<SeatService> as SeatService
  ctx.provide('seats', service)
  ctx.provide('seatEngine', { nodeStatus: async () => ({ nodeId: 'node-a' }) } as SeatEngineService)
  const remote = new SeatRemote(ctx)
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  return { ctx, remote, service, open, openBatch, withAuthority }
}

describe('authenticated seat Remote', () => {
  it('forces automatic opening through SeatService with invocation-derived authority', async () => {
    const f = fixture()
    try {
      expect(await f.remote.open({ seat: 'seat-a' as never, operationId: 'operation-a' as never, origin: 'manual', openingMode: 'prefill' })).toEqual({ status: 'cancelled' })
      expect(f.open).toHaveBeenCalledWith({ seat: 'seat-a', operationId: 'operation-a', origin: 'remote', openingMode: 'auto' })
      expect(f.withAuthority).toHaveBeenCalledWith({ principalId: 'owner', origin: 'remote', nodeId: 'node-a' })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('rejects unauthenticated calls and wildcard batches without a window effect', async () => {
    const f = fixture()
    try {
      await expect(f.remote.openBatch({ seats: ['all'] as never, operationId: 'operation-a' as never, origin: 'remote' })).rejects.toThrow()
      expect(f.openBatch).not.toHaveBeenCalled()
      Object.defineProperty(f.ctx, 'invocation', { value: undefined })
      await expect(f.remote.open({ seat: 'seat-a' as never, operationId: 'operation-a' as never, origin: 'remote' })).rejects.toThrow('authenticated owner')
      expect(f.open).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })
  it('protects management calls with invocation authority and request validation', async () => {
    const f = fixture()
    const setAuthority = vi.fn(async () => ({ status: 'saved' as const, revision: 2 }))
    f.service.setAuthority = setAuthority
    const request = { authority: 'seat-store' as const, authorizationRef: 'authorization-a' as never, expectedRevision: 1, operationId: 'operation-a' as never }
    try {
      expect(await f.remote.setAuthority(request)).toEqual({ status: 'saved', revision: 2 })
      expect(setAuthority).toHaveBeenCalledExactlyOnceWith(request)
      await expect(f.remote.setAuthority({ ...request, expectedRevision: -1 })).rejects.toThrow()
      Object.defineProperty(f.ctx, 'invocation', { value: undefined })
      await expect(f.remote.setAuthority(request)).rejects.toThrow('authenticated owner')
      expect(setAuthority).toHaveBeenCalledTimes(1)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('does not construct providers when the plugin is absent', async () => {
    const ctx = new Context()
    try { expect(ctx.get('seats')).toBeUndefined(); expect(ctx.get('seatEngine')).toBeUndefined() }
    finally { await ctx.fiber.dispose() }
  })
})
