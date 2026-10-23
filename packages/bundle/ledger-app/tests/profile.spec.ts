import { Context } from '@panedesk/cordis'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import { LedgerQueryService } from '@panedesk/dsh-ledger-query'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

describe('minimal offline ledger app', () => {
  it('waits for AppReady, queries without a model or key, and requests AppExit', async () => {
    const ctx = new Context(), exit = vi.fn()
    let listener: (() => void) | undefined
    provideCmdline(ctx, { args: ['today'], exit, ready: { onReady: (callback) => { listener = callback; return () => { listener = undefined } } } })
    new LedgerQueryService(ctx)
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      apply(ctx, { mode: 'query', engineReader: { maxDecisionBytes: 200000 } })
      expect(ctx.get('seatEngineQuery')).toBeUndefined()
      expect(ctx.get('seatGatesQuery')).toBeUndefined()
      expect(exit).not.toHaveBeenCalled()
      expect(output).not.toHaveBeenCalled()
      listener!()
      await vi.waitFor(() =>{  expect(exit).toHaveBeenCalledWith(0) })
      const text = output.mock.calls[0]![0]
      expect(JSON.parse(String(text))).toMatchObject({ timezone: 'Asia/Shanghai', complete: false, liveSessions: 0 })
    } finally { output.mockRestore(); await ctx.fiber.dispose() }
  })
  it('exits with failure for unknown arguments without leaking raw errors', async () => {
    const ctx = new Context(), exit = vi.fn()
    let listener!: () => void
    provideCmdline(ctx, { args: ['today', '--guess'], exit, ready: { onReady: (callback) => { listener = callback; return () => {} } } })
    new LedgerQueryService(ctx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      apply(ctx, { mode: 'query' }); listener()
      await vi.waitFor(() =>{  expect(exit).toHaveBeenCalledWith(1) })
      expect(error).toHaveBeenCalledWith('Ledger command failed; check arguments, input integrity and output permissions')
    } finally { error.mockRestore(); await ctx.fiber.dispose() }
  })
  it('requires launcher lifecycle and explicit watch node configuration', async () => {
    const absent = new Context()
    expect(() =>{  apply(absent, { mode: 'query' }) }).toThrow('launcher')
    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { onReady: () => () => {} } })
    expect(() =>{  apply(ctx, { mode: 'watch' }) }).toThrow('local node')
    apply(ctx, { mode: 'watch', nodeId: 'node-a' })
    await ctx.fiber.dispose(); await absent.fiber.dispose()
  })
})
