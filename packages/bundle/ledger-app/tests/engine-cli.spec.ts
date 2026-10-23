import { Context } from '@panedesk/cordis'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import type { SeatEngineService, SeatGateService, SeatGatesQueryService } from '@panedesk/dsh-seat'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

describe('offline engine command projection', () => {
  it('queries the independent engine reader after readiness without starting an agent', async () => {
    const ctx = new Context(), exit = vi.fn(), query = vi.fn(async () => ({ effects: [], complete: true, watermark: 7 }))
    let ready: (() => void) | undefined
    provideCmdline(ctx, { args: ['engine', 'events', '--seat', 'seat-a'], exit,
      ready: { onReady(callback) { ready = callback; return () => { ready = undefined } } } })
    ctx.provide('seatEngine', { query } as Partial<SeatEngineService> as SeatEngineService)
    await ctx.plugin(LedgerQuery)
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      apply(ctx, { mode: 'query' })
      expect(query).not.toHaveBeenCalled()
      ready?.()
      await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
      expect(query).toHaveBeenCalledWith({ seat: 'seat-a', limit: 100 })
      expect(output).toHaveBeenCalledWith('{"effects":[],"complete":true,"watermark":7}\n')
      expect(ctx.get('agents')).toBeUndefined()
    } finally { output.mockRestore(); await ctx.fiber.dispose() }
    expect(ready).toBeUndefined()
  })
  it('prefers the gate reader, falls back to live gates and retains unavailable without either', async () => {
    const ctx = new Context()
    await ctx.plugin(LedgerQuery)
    const live = vi.fn(async () => ({ gates: [], complete: true, watermark: 3 }))
    const offline = vi.fn(async () => ({ gates: [], complete: true, watermark: 7 }))
    try {
      expect(await ctx.ledgerQuery.execute(['engine', 'gates'])).toMatchObject({ code: 2, output: { error: { code: 'unavailable' } } })
      ctx.provide('seatGates', { list: live } as Partial<SeatGateService> as SeatGateService)
      expect(await ctx.ledgerQuery.execute(['engine', 'gates'])).toMatchObject({ code: 0, output: { watermark: 3 } })
      ctx.provide('seatGatesQuery', { list: offline } as Partial<SeatGatesQueryService> as SeatGatesQueryService)
      expect(await ctx.ledgerQuery.execute(['engine', 'gates'])).toMatchObject({ code: 0, output: { watermark: 7 } })
      expect(live).toHaveBeenCalledTimes(1)
      expect(offline).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })
  it('reports unavailable without a seat plugin rather than querying accounting data', async () => {
    const ctx = new Context()
    await ctx.plugin(LedgerQuery)
    try {
      expect(await ctx.ledgerQuery.execute(['engine', 'events'])).toMatchObject({ code: 2, output: { error: { code: 'unavailable' } } })
      expect(ctx.get('seatEngine')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
