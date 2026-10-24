/** Execution policies retain unknown work and invalidate asynchronous checks after queue changes. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, trigger } from './fixtures.ts'

const refusal = (effectState: 'none' | 'unknown'): T.SeatRejected => ({ status: 'rejected', error: {
  code: 'gate-denied', message: 'Frozen permission changed.', alternative: 'Submit fresh preflight.', retryable: false, effectState,
} })

it.each(['allow', 'none', 'unknown', 'throw'] as const)('checks queued work before any intent with outcome %s', async (outcome) => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const recheck = vi.fn(async () => {
    if (outcome === 'throw') throw new Error('Unavailable policy')
    return outcome === 'allow' ? null : refusal(outcome)
  })
  try {
    h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'prefill' }), requiresRecheck: () => true, recheck })
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.drive()
    expect(h.creates).toHaveLength(outcome === 'allow' ? 1 : 0)
    expect(h.engine.journal.projection.pending.size).toBe(outcome === 'unknown' || outcome === 'throw' ? 1 : 0)
    expect(h.engine.journal.projection.opens.size).toBe(outcome === 'allow' ? 1 : 0)
  } finally { await h.close() }
})

it('rechecks a created but unfinished opening after restart before configuring or sending', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const access: T.SeatEngineLocalAccess = { list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'auto' }), requiresRecheck: () => true,
    recheck: async () => null }
  try {
    h.engine.registerLocalAccess(access)
    const configure = vi.fn(h.executor.configure.bind(h.executor))
    h.executor.configure = async () => { throw new Error('Interrupted configuration') }
    await auto(h.engine)
    await h.engine.accept(trigger())
    await expect(h.engine.drive()).rejects.toThrow('Interrupted configuration')
    expect(h.creates).toHaveLength(1)
    await h.engine.shutdown()
    h.executor.configure = configure
    const opening = vi.fn(h.executor.opening.bind(h.executor))
    h.executor.opening = opening
    const restarted = await h.start()
    restarted.registerLocalAccess({ ...access, recheck: async () => refusal('none') })
    await restarted.drive()
    expect(configure).not.toHaveBeenCalled()
    expect(opening).not.toHaveBeenCalled()
    expect(restarted.journal.projection.resources.size).toBe(1)
  } finally { await h.close() }
})

it('retains a required policy after restart and refuses to dispatch without its registration', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  try {
    const remove = h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'prefill' }), requiresRecheck: () => true,
      recheck: async () => null })
    await auto(h.engine)
    await h.engine.accept(trigger())
    await remove()
    await h.engine.shutdown()
    const restarted = await h.start()
    await restarted.drive()
    expect(h.creates).toEqual([])
    expect([...restarted.journal.projection.pending.values()]).toMatchObject([{ frozenOpen: { recheckRequired: true } }])
  } finally { await h.close() }
})

it('discards permission when a source coalesces during the asynchronous check', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let once = false
  try {
    h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'prefill' }), requiresRecheck: () => true,
      recheck: async () => { if (!once) { once = true; await h.engine.accept(trigger('external', 'second')) }; return null } })
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.drive()
    expect(h.creates).toEqual([])
    expect([...h.engine.journal.projection.pending.values()][0]?.sources).toHaveLength(2)
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

it.each(['none', 'unknown'] as const)('blocks creation with %s permission after dispatch commits its intent', async (state) => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let calls = 0
  try {
    h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'prefill' }), requiresRecheck: () => true,
      recheck: async () => ++calls === 1 ? null : refusal(state) })
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.drive()
    expect(h.engine.journal.projection.opens.size).toBe(1)
    expect(h.creates).toEqual([])
    expect(h.engine.journal.projection.resources.size).toBe(state === 'none' ? 0 : 1)
  } finally { await h.close() }
})
