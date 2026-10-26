/** Execution policies retain unknown work and invalidate asynchronous checks after queue changes. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, trigger } from './fixtures.ts'
import { retentionSince } from '../src/execution-recheck.ts'

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

it('retains retryable no-effect refusals without changing the queue on repeated checks', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  try {
    h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'auto' }), requiresRecheck: () => true,
      recheck: async () => ({ ...refusal('none'), error: { ...refusal('none').error, retryable: true } }) })
    await h.engine.accept(trigger())
    const original = [...h.engine.journal.projection.pending.values()][0]!
    await h.engine.drive()
    const retained = h.engine.journal.projection.pending.get(original.queueItemId)
    expect(retained).toMatchObject({ reason: 'provider-unavailable', blockedBy: ['provider-unavailable'],
      queuedAt: original.queuedAt, sources: original.sources, frozenOpen: original.frozenOpen })
    await h.engine.drive()
    expect(h.engine.journal.projection.pending.get(original.queueItemId)).toEqual(retained)
    expect(h.engine.journal.projection.opens.size).toBe(0)
    expect(h.engine.journal.projection.callbacks.size).toBe(0)
  } finally { await h.close() }
})

it.each(['none', 'unknown', 'committed'] as const)('retains retryable %s checks across approval, coalescing and restart', async (effectState) => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const access: T.SeatEngineLocalAccess = { list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Frozen', openingMode: 'auto' }), requiresRecheck: () => true,
    recheck: async () => ({ status: 'rejected', error: { ...refusal('none').error, retryable: true, effectState } }) }
  try {
    h.engine.registerLocalAccess(access)
    await h.engine.accept(trigger())
    await h.engine.drive()
    const blocked = [...h.engine.journal.projection.pending.values()][0]!
    const since = retentionSince(h.engine.journal.projection, blocked.queueItemId)
    expect(since).toBeTypeOf('number')
    expect(blocked).toMatchObject({ reason: 'provider-unavailable', blockedBy: ['provider-unavailable'] })
    await h.engine.approve({ queueItemId: blocked.queueItemId, expectedStateVersion: blocked.stateVersion,
      operationId: 'approve-transient' as T.SeatOperationId })
    await h.engine.accept(trigger('external', 'merged-transient'))
    const merged = h.engine.journal.projection.pending.get(blocked.queueItemId)!
    expect(merged).toMatchObject({ reason: blocked.reason, blockedBy: blocked.blockedBy, queuedAt: blocked.queuedAt })
    await h.engine.shutdown()
    const restarted = await h.start()
    const remove = restarted.registerLocalAccess(access)
    await restarted.drive()
    expect(restarted.journal.projection.pending.get(blocked.queueItemId)).toEqual(merged)
    expect(retentionSince(restarted.journal.projection, blocked.queueItemId)).toBe(since)
    expect(restarted.journal.projection.approved.has(blocked.queueItemId)).toBe(true)
    expect(h.creates).toHaveLength(0)
    await remove()
    restarted.registerLocalAccess({ ...access, recheck: async () => null })
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
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
