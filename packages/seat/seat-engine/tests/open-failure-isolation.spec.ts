/** Unavailable opening prerequisites affect one Session, not unrelated durable work. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, definition, harness, seat, trigger } from './fixtures.ts'
import { fact } from '../src/triggers.ts'
import { digest } from '../src/journal.ts'

it('contains an unavailable model during scheduled recovery and opens the healthy seat', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const h = await harness({ failureRecovery: { retryInitialMs: 1000 } })
  const healthy = 'healthy-seat' as T.SeatName
  h.definitions.set(healthy, definition(healthy))
  const configure = h.executor.configure.bind(h.executor)
  h.executor.configure = async (open, stage) => {
    if (open.definition?.seat === seat && stage === 'model') {
      throw Object.assign(new Error('Select an available model before sending a message.'), {
        name: 'RemoteError', code: 'session/model-unavailable', isDSHRemoteError: true,
        details: { provider: 'provider-a', model: 'model-a' },
      })
    }
    await configure(open, stage)
  }
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.accept(trigger('external', 'healthy-event', healthy))
    await vi.advanceTimersByTimeAsync(1000)
    await h.engine.drive()
    const opens = [...h.engine.journal.projection.opens.values()]
    expect(opens.find(open => open.definition?.seat === seat)).toMatchObject({ phase: 'opening-failed',
      failure: { code: 'open-configuration-failed', effectState: 'partial',
        details: { provider: 'provider-a', model: 'model-a' } } })
    expect(opens.find(open => open.definition?.seat === healthy)?.phase).toBe('active')
    expect((await h.engine.nodeStatus()).engine).toBe('running')
    expect((await h.engine.nodeStatus()).openingFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ seat, model: 'model-a', code: 'open-configuration-failed' }),
    ]))
    await h.engine.drive()
    expect(h.creates).toHaveLength(2)
    const failed = opens.find(open => open.definition?.seat === seat)!
    h.executor.configure = configure
    expect(await h.engine.admitTurn(failed.sessionId)).toEqual({ status: 'allow' })
    expect(h.engine.journal.projection.opens.get(failed.sessionId)).toMatchObject({ phase: 'active', failure: null })
    expect((await h.engine.nodeStatus()).openingFailures ?? []).toEqual([])
    expect(h.creates).toHaveLength(2)
  } finally { await h.close(); vi.useRealTimers() }
})

it.each(['create', 'configure', 'opening'] as const)('contains an invalid definition during %s and clears after repair', async (stage) => {
  const h = await harness({ ownerObserveIntervalMs: 60000, failureRecovery: { retryInitialMs: 1000 } })
  const healthy = 'healthy-seat' as T.SeatName
  h.definitions.set(healthy, definition(healthy))
  const original = { ...h.executor }
  const reject = (open: T.EngineOpenData) => {
    if (open.definition?.seat === seat) throw Object.assign(new Error('Invalid opening template'), {
      failure: { code: 'invalid-definition', message: 'Invalid opening template',
        alternative: 'Repair the definition and reopen.', retryable: false, effectState: 'none' },
    })
  }
  if (stage === 'create') h.executor.create = async (open) => { reject(open); return original.create(open) }
  else if (stage === 'configure') h.executor.configure = async (open, step) => { reject(open); await original.configure(open, step) }
  else h.executor.opening = async (open) => { reject(open); return original.opening(open) }
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.accept(trigger('external', 'healthy-event', healthy))
    await expect(h.engine.drive()).resolves.toBeUndefined()
    const opens = [...h.engine.journal.projection.opens.values()]
    const failed = opens.find(open => open.definition?.seat === seat)!
    expect(failed).toMatchObject({ phase: 'opening-failed', failure: { code: 'invalid-definition',
      effectState: stage === 'create' ? 'none' : 'partial' } })
    expect(opens.find(open => open.definition?.seat === healthy)?.phase).toBe('active')
    expect(await h.engine.nodeStatus()).toMatchObject({ engine: 'running', openingFailures: [
      { seat, code: 'invalid-definition' },
    ] })
    expect((await h.engine.nodeStatus()).failure).toBeUndefined()
    const provider: { resolve(name: T.SeatName): Promise<T.SeatDefinition | T.SeatRejected> } = h.seatProvider
    const resolve = vi.spyOn(provider, 'resolve').mockResolvedValueOnce({ status: 'rejected', error: {
      code: 'invalid-definition', message: 'Unresolved definition', alternative: 'Repair definition', retryable: false, effectState: 'none',
    } })
    expect((await h.engine.nodeStatus()).openingFailures).toEqual([expect.objectContaining({ seat, code: 'invalid-definition' })])
    resolve.mockRestore()
    Object.assign(h.executor, original)
    if (stage === 'create') {
      await h.engine.accept(trigger('external', 'reopen-event'))
      await h.engine.drive()
      expect([...h.engine.journal.projection.opens.values()].findLast(open => open.definition?.seat === seat)?.phase).toBe('active')
    } else h.definitions.set(seat, { ...definition(), revision: 2 })
    expect((await h.engine.nodeStatus()).openingFailures ?? []).toEqual([])
  } finally { await h.close() }
})

it('retains a sent opening when invalid definition evidence cannot settle its outcome', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const h = await harness({ ownerObserveIntervalMs: 60000, failureRecovery: { retryInitialMs: 1000 } })
  h.state.opening = 'pending'
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.drive()
    const open = [...h.engine.journal.projection.opens.values()][0]!
    expect(open.phase).toBe('opening-pending')
    expect(open.openingMessageId).not.toBeNull()
    h.executor.opening = async () => { throw Object.assign(new Error('Invalid retained template'), {
      failure: { code: 'invalid-definition' },
    }) }
    await expect(h.engine.drive()).rejects.toMatchObject({ failure: { code: 'invalid-definition' } })
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.engine.journal.projection.opens.get(open.sessionId)).toMatchObject({
      phase: 'opening-pending', openingMessageId: open.openingMessageId, failure: null,
    })
    expect(await h.engine.nodeStatus()).toMatchObject({ engine: 'unavailable', failure: {
      code: 'invalid-definition', retryable: false,
    } })
  } finally { await h.close(); vi.useRealTimers() }
})

it('isolates a missing preset before creation and recovers the remaining opening', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000, failureRecovery: { retryInitialMs: 1000 } })
  const healthy = 'healthy-seat' as T.SeatName
  h.definitions.set(healthy, definition(healthy))
  const create = h.executor.create.bind(h.executor)
  const frozenOpening = { text: 'Retained opening', digest: digest('Retained opening'),
    variables: { seat, date: '2026-01-01', taskId: null } }
  h.executor.create = async (open) => {
    if (open.definition?.seat === seat) {
      await h.engine.journal.commit(() => [fact({ kind: 'open/intent', data: { ...open, frozenOpening } })])
      throw Object.assign(new Error('Unknown agent preset'), {
        name: 'RemoteError', code: 'agent-preset/not-found', isDSHRemoteError: true,
        details: { agentPreset: open.definition?.agentPreset, available: [] },
      })
    }
    return create(open)
  }
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.accept(trigger('external', 'healthy-event', healthy))
    await expect(h.engine.drive()).resolves.toBeUndefined()
    const opens = [...h.engine.journal.projection.opens.values()]
    expect(opens.find(open => open.definition?.seat === seat)?.frozenOpening).toEqual(frozenOpening)
    expect(opens.find(open => open.definition?.seat === seat)).toMatchObject({ phase: 'opening-failed',
      failure: { code: 'open-create-failed', retryable: false, effectState: 'none' } })
    expect(opens.find(open => open.definition?.seat === seat)?.failure).toMatchObject({
      details: { agentPreset: 'agent-a' },
    })
    expect(opens.find(open => open.definition?.seat === healthy)?.phase).toBe('active')
    expect(h.engine.journal.projection.resources.size).toBe(1)
    expect(h.creates).toHaveLength(1)
    expect((await h.engine.nodeStatus()).engine).toBe('running')
    await h.engine.shutdown()
    const restarted = await h.start()
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.resources.size).toBe(1)
  } finally { await h.close() }
})
