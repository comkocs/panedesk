import { afterEach, expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, definition, harness, seat, trigger } from './fixtures.ts'
import { fact } from '../src/triggers.ts'
import { digest } from '../src/journal.ts'

it('retains executor-frozen opening text and a newer budget through replay', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  const create = h.executor.create.bind(h.executor)
  const frozenOpening = { text: 'Retained opening', digest: digest('Retained opening'),
    variables: { seat, date: '2026-01-01', taskId: null } }
  h.executor.create = async (open) => {
    await h.engine.journal.commit(() => [fact({ kind: 'open/intent', data: { ...open, frozenOpening } })])
    return create(open)
  }
  h.state.opening = 'pending'
  await h.engine.accept(trigger()); await h.engine.drive()
  const before = [...h.engine.journal.projection.opens.values()][0]!
  expect(before.frozenOpening).toEqual(frozenOpening)
  await h.engine.configureBudget({ sessionId: before.sessionId, expectedRevision: 0,
    limits: { windowBudgetUsd: '100' as T.MicroUsd }, operationId: 'budget-a' as T.SeatOperationId,
    authorizationRef: 'authority-a' as T.AuthorizationRef })
  await h.engine.drive()
  expect((await h.engine.budget(before.sessionId)).budgetRevision).toBe(1)
  await h.engine.shutdown()
  const recovered = await h.start(); await recovered.drive()
  expect(recovered.journal.projection.opens.get(before.sessionId)?.frozenOpening).toEqual(frozenOpening)
  expect((await recovered.budget(before.sessionId)).budgetRevision).toBe(1)
  expect(h.creates).toHaveLength(1)
})

it('recovers after a slow release of the previous process owner without releasing it twice', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const h = await harness({ failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } })
  let clock = 0
  const timer = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.drive()
    const sessionId = h.creates[0]!
    await h.engine.shutdown()
    h.executor.owner = async () => { clock += 2001; return 'dead' }
    const restarted = await h.start()
    await restarted.drive()
    expect((await restarted.nodeStatus()).failure).toMatchObject({
      code: 'owner-release-budget-exceeded', retryable: true, attempts: 1,
    })
    await vi.advanceTimersByTimeAsync(1999)
    expect((await restarted.nodeStatus()).engine).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(1)
    await restarted.drive()
    expect((await restarted.nodeStatus()).engine).toBe('running')
    const releases = restarted.journal.projection.decisions.flatMap(decision => decision.effects)
      .filter(effect => effect.kind === 'resource/released' && effect.sessionId === sessionId)
    expect(releases).toHaveLength(1)
    expect(releases[0]?.data).toMatchObject({ reason: 'host-restart-recovery', fenced: true })
  } finally { timer.mockRestore(); await h.close(); vi.useRealTimers() }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it.each(['create', 'workspace', 'model', 'permission', 'subscriptions', 'title', 'binding',
  'opening'] as const)('A09 resumes the original identity after interruption at %s', async (stage) => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  let interrupted = false
  const originalCreate = h.executor.create.bind(h.executor), originalConfigure = h.executor.configure.bind(h.executor),
    originalOpening = h.executor.opening.bind(h.executor)
  h.executor.create = async (open) => { const id = await originalCreate(open); if (stage === 'create' && !interrupted) { interrupted = true
    throw new Error('Interrupted after materialization') }; return id }
  h.executor.configure = async (open, step) => { await originalConfigure(open, step)
    if (stage === step && !interrupted) { interrupted = true
      throw new Error('Interrupted configuration') } }
  h.executor.opening = async (open) => { const result = await originalOpening(open); if (stage === 'opening' && !interrupted) { interrupted = true
    throw new Error('Interrupted acknowledgement') }; return result }
  await h.engine.accept(trigger())
  await expect(h.engine.drive()).rejects.toThrow('Interrupted')
  const before = [...h.engine.journal.projection.opens.values()][0]!
  await h.engine.shutdown()
  const recovered = await h.start(); await recovered.drive()
  expect(h.creates).toHaveLength(1); expect(h.physical.size).toBe(1)
  const after = recovered.journal.projection.opens.get(before.sessionId)!
  expect(after.phase).toBe('active'); expect(after.openingOperationId).toBe(before.openingOperationId)
  expect((await recovered.pending({ limit: 10 })).items).toEqual([])
})
it('A16 retains unknown owners and releases confirmed deaths within five seconds from engine ready', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  const second = 'seat-b' as T.SeatName
  for (const name of [seat, second]) {
    const def = definition(name)
    def.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external',
      sourceId: trigger().sourceId }, timeWindows: [], exclusiveTags: ['resource-a'] }]
    h.definitions.set(name, def)
  }
  await h.engine.accept(trigger()); await h.engine.drive()
  await h.engine.accept(trigger('external', 'event-b', second))
  h.state.owner = 'unknown'; await h.engine.drive()
  expect(h.creates).toHaveLength(1)
  await h.engine.shutdown(); h.state.owner = 'dead'
  const recovered = await h.start(), start = performance.now()
  await recovered.drive()
  expect(performance.now() - start).toBeLessThan(5000)
  expect(h.creates).toHaveLength(2)
  const releases = recovered.journal.projection.decisions.flatMap(d => d.effects).filter(e => e.kind === 'resource/released')
  expect(releases[0]?.data).toMatchObject({ reason: 'host-restart-recovery', engineReadyAt: (await recovered.nodeStatus()).readyAt,
    fenced: true })
  expect(await recovered.admitTurn(h.creates[0]!)).toEqual({ status: 'defer', reason: 'owner-unknown' })
})
