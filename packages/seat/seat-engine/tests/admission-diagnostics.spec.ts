/** Admission failures distinguish configuration from untrusted accounting evidence. */
import { expect, it, vi } from 'vitest'
import { EngineError } from '../src/journal.ts'
import { auto, harness, trigger } from './fixtures.ts'

it.each(['engine-store-corrupt', 'state-conflict', 'budget-unverifiable', 'invalid-definition', 'unexpected-code'] as const)(
  'keeps accounting failure %s stopped at the actual query site', async (code) => {
    const h = await harness({ failureRecovery: { retryInitialMs: 2000 }, ownerObserveIntervalMs: 60000 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await auto(h.engine); await h.engine.accept(trigger()); await h.engine.drive()
      const sessionId = h.creates[0]
      if (!sessionId) throw new Error('Expected active window')
      const error = code === 'unexpected-code' ? Object.assign(new Error('Untrusted detail'), { code }) : new EngineError(code, 'Untrusted detail')
      vi.spyOn(h.engine, 'budget').mockRejectedValue(error)
      await expect(h.engine.admitTurn(sessionId)).rejects.toBe(error)
      expect((await h.engine.nodeStatus()).failure).toMatchObject({ site: 'turn-admission',
        code: code === 'unexpected-code' ? 'unclassified-error' : code, retryable: false })
      expect((await h.engine.nodeStatus()).engine).toBe('unavailable')
    } finally { vi.restoreAllMocks(); await h.close() }
  })
