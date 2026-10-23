import { Context } from '@panedesk/cordis'
import { expect, it, vi } from 'vitest'
import type { SeatEngineQueryService, SeatEngineService } from '@panedesk/dsh-seat'
import { executeEngine } from '../src/engine.ts'

function reader() {
  const query = vi.fn<SeatEngineQueryService['query']>(async () => ({ effects: [], complete: true, watermark: 3 }))
  const pending = vi.fn<SeatEngineQueryService['pending']>(async () => ({ items: [], complete: true, watermark: 3 }))
  const exportFrames = vi.fn<SeatEngineQueryService['export']>(async () => ({ status: 'exported', count: 0,
    digest: 'digest-a' as never, watermark: 3, content: '', complete: true }))
  const verify = vi.fn<SeatEngineQueryService['verify']>(async () => ({ status: 'verified', decisions: 0, watermark: 0, tail: 'complete' }))
  return { query, pending, export: exportFrames, verify }
}

it('prefers the read-only service over the live engine for every observation', async () => {
  const ctx = new Context(), read = reader(), live = reader()
  ctx.provide('seatEngineQuery', read as Partial<SeatEngineQueryService> as SeatEngineQueryService)
  ctx.provide('seatEngine', live as Partial<SeatEngineService> as SeatEngineService)
  try {
    expect(await executeEngine(ctx, { action: 'events', request: { limit: 1 } })).toMatchObject({ code: 0, output: { watermark: 3 } })
    await executeEngine(ctx, { action: 'pending', request: { limit: 1 } })
    await executeEngine(ctx, { action: 'export', request: { query: { limit: 1 }, format: 'jsonl', output: 'unused.jsonl' } })
    await executeEngine(ctx, { action: 'verify', request: { input: 'input.jsonl' } })
    for (const method of ['query', 'pending', 'export', 'verify'] as const) {
      expect(read[method]).toHaveBeenCalledOnce()
      expect(live[method]).not.toHaveBeenCalled()
    }
    expect(await executeEngine(ctx, { action: 'gates', request: { limit: 1 } })).toMatchObject({ code: 2, output: { error: { code: 'unavailable' } } })
  } finally { await ctx.fiber.dispose() }
})

it('falls back to the live engine only when the read-only service is absent', async () => {
  const ctx = new Context(), live = reader()
  ctx.provide('seatEngine', live as Partial<SeatEngineService> as SeatEngineService)
  try {
    expect(await executeEngine(ctx, { action: 'events', request: { limit: 1 } })).toMatchObject({ code: 0, output: { watermark: 3 } })
    expect(live.query).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it('preserves the unavailable exit code and text when both services are absent', async () => {
  const ctx = new Context()
  try {
    expect(await executeEngine(ctx, { action: 'events', request: { limit: 1 } })).toEqual({ code: 2,
      output: { status: 'rejected', error: { code: 'unavailable', message: 'The engine query provider is unavailable.',
        alternative: 'Install the read-only engine provider.', retryable: true, effectState: 'none' } } })
  } finally { await ctx.fiber.dispose() }
})

it('returns rejected read status without falling back to an active writer', async () => {
  const ctx = new Context(), read = reader(), live = reader()
  const refusal = { status: 'rejected', error: { code: 'unavailable', message: 'No journal.', alternative: 'Select an existing journal.',
    retryable: true, effectState: 'none' } } as const
  read.query.mockResolvedValue(refusal); read.pending.mockResolvedValue(refusal)
  ctx.provide('seatEngineQuery', read as Partial<SeatEngineQueryService> as SeatEngineQueryService)
  ctx.provide('seatEngine', live as Partial<SeatEngineService> as SeatEngineService)
  try {
    expect(await executeEngine(ctx, { action: 'events', request: { limit: 1 } })).toEqual({ code: 2, output: refusal })
    expect(await executeEngine(ctx, { action: 'pending', request: { limit: 1 } })).toEqual({ code: 2, output: refusal })
    expect(live.query).not.toHaveBeenCalled(); expect(live.pending).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
