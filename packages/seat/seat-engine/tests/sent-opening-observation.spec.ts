/** Sent opening results survive admission changes without granting new Session effects. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, trigger } from './fixtures.ts'

const stale: T.SeatRejected = { status: 'rejected', error: { code: 'gate-denied', message: 'scope-stale',
  alternative: 'Submit fresh preflight.', retryable: false, effectState: 'none' } }

it.each([
  ['failed', false], ['completed', false], ['failed', true], ['completed', true],
] as const)('observes a sent %s opening after scope-stale (restart: %s)', async (outcome, restart) => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let denied = false
  const recheck = vi.fn(async () => denied ? stale : null)
  const access: T.SeatEngineLocalAccess = { list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'auto' }), requiresRecheck: () => true, recheck }
  const opening = vi.fn(h.executor.opening.bind(h.executor))
  const configure = vi.fn(h.executor.configure.bind(h.executor))
  h.executor.opening = opening
  h.executor.configure = configure
  try {
    let engine = h.engine
    engine.registerLocalAccess(access)
    h.state.opening = 'pending'
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    await vi.waitFor(() => { expect(h.callbacks.map(item => item.kind)).toEqual(['opened']) })
    const sent = [...engine.journal.projection.opens.values()][0]!
    expect(sent).toMatchObject({ phase: 'opening-pending', openingMessageId: 'opening-a' })
    const resource = engine.journal.projection.resources.get(sent.sessionId)
    denied = true
    h.state.opening = outcome
    if (restart) {
      await engine.shutdown()
      engine = await h.start()
      engine.registerLocalAccess(access)
    }
    recheck.mockClear()
    configure.mockClear()
    opening.mockClear()
    await engine.drive()
    expect(engine.journal.projection.opens.get(sent.sessionId)?.phase).toBe(outcome === 'failed' ? 'opening-failed' : 'active')
    expect(recheck).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
    expect(opening).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ openingMessageId: sent.openingMessageId }))
    const kinds = outcome === 'failed' ? ['opened', 'opening-failed'] : ['opened']
    await vi.waitFor(() => { expect(h.callbacks.map(item => item.kind)).toEqual(kinds) })
    const callbacks = [...engine.journal.projection.callbacks.values()].map(item => item.payload)
    expect(callbacks.map(item => item.kind)).toEqual(kinds)
    if (outcome === 'failed') {
      expect(callbacks[1]!.stateVersion).toBeGreaterThan(callbacks[0]!.stateVersion)
      expect(callbacks[1]).toMatchObject({ sessionId: sent.sessionId, sourceId: callbacks[0]!.sourceId,
        reason: { code: 'opening-failed', effectState: 'partial' } })
    }
    await engine.drive()
    await engine.shutdown()
    engine = await h.start()
    engine.registerLocalAccess(access)
    await engine.drive()
    await engine.shutdown()
    expect(opening).toHaveBeenCalledTimes(1)
    expect(h.creates).toEqual([sent.sessionId])
    expect(h.closed).toEqual([])
    expect(h.physical.has(sent.sessionId)).toBe(true)
    expect(engine.journal.projection.resources.get(sent.sessionId)).toEqual(resource)
    expect(h.callbacks.map(item => item.kind)).toEqual(kinds)
    expect([...engine.journal.projection.callbacks.values()].map(item => item.payload)).toEqual(callbacks)
    const failures = engine.journal.projection.decisions.flatMap(item => item.effects)
      .filter(item => item.kind === 'open/opening-failed')
    expect(failures).toHaveLength(outcome === 'failed' ? 1 : 0)
    if (outcome === 'failed') expect(failures[0]).toMatchObject({ data: {
      phase: 'opening-failed', openingMessageId: sent.openingMessageId, sessionId: sent.sessionId } })
  } finally { await h.close() }
})

it.each(['create', 'configure', 'send'] as const)('keeps scope-stale blocking before %s', async (boundary) => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let denied = false, checks = 0
  const access: T.SeatEngineLocalAccess = { list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'auto' }), requiresRecheck: () => true,
    recheck: async () => denied || boundary === 'create' && ++checks > 1 ? stale : null }
  const configure = vi.fn(h.executor.configure.bind(h.executor))
  const opening = vi.fn(h.executor.opening.bind(h.executor))
  try {
    h.engine.registerLocalAccess(access)
    if (boundary === 'configure') h.executor.configure = async () => { throw new Error('Interrupted before configuration') }
    if (boundary === 'send') h.executor.opening = async () => { throw new Error('Interrupted before first send') }
    await auto(h.engine)
    await h.engine.accept(trigger())
    if (boundary === 'create') await h.engine.drive()
    else await expect(h.engine.drive()).rejects.toThrow('Interrupted before')
    const unfinished = [...h.engine.journal.projection.opens.values()][0]!
    expect(unfinished.openingMessageId).toBeNull()
    if (boundary === 'send') expect(unfinished.phase).toBe('opening-pending')
    denied = true
    await h.engine.shutdown()
    h.executor.configure = configure
    h.executor.opening = opening
    const engine = await h.start()
    engine.registerLocalAccess(access)
    await engine.drive()
    expect(configure).not.toHaveBeenCalled()
    expect(opening).not.toHaveBeenCalled()
    expect(h.creates).toHaveLength(boundary === 'create' ? 0 : 1)
    expect(engine.journal.projection.resources.size).toBe(boundary === 'create' ? 0 : 1)
  } finally { await h.close() }
})
