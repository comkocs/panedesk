import { Context } from '@panedesk/cordis'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import type { SeatEngineService } from '@panedesk/dsh-seat'
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
  it('reports unavailable without a seat plugin rather than querying accounting data', async () => {
    const ctx = new Context()
    await ctx.plugin(LedgerQuery)
    try {
      expect(await ctx.ledgerQuery.execute(['engine', 'events'])).toMatchObject({ code: 2, output: { error: { code: 'unavailable' } } })
      expect(ctx.get('seatEngine')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
