import { afterEach, expect, it, vi } from 'vitest'
import type { CacheRemaining } from '@panedesk/dsh-llm-cache'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, seat, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers() })
async function setup(ttlSeconds = 3600) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const state: { evidence: CacheRemaining; calls: T.SeatOperationId[] } = {
    evidence: { kind: 'estimated', evidenceAt: Date.now(), ttlSeconds, seconds: ttlSeconds }, calls: [],
  }
  const h = await harness({}, {
    remaining: () => Promise.resolve(state.evidence),
    renew: (_sessionId, operationId) => {
      state.calls.push(operationId)
      state.evidence = { kind: 'estimated', evidenceAt: Date.now(), ttlSeconds, seconds: ttlSeconds }
      return Promise.resolve({ kind: 'renewed', evidenceAt: Date.now() })
    },
  }); cleanups.push(h.close)
  await auto(h.engine); await h.engine.accept(trigger()); await h.engine.drive()
  const sessionId = h.creates[0]
  if (!sessionId) throw new Error('Missing window')
  return { ...h, cache: state, sessionId }
}
it('A28 renews once per idle cache period without invoking another opening', async () => {
  const h = await setup(); const opening = vi.spyOn(h.executor, 'opening')
  vi.setSystemTime(Date.now() + 56 * 60000); await h.engine.drive(); await h.engine.drive()
  expect(h.cache.calls).toHaveLength(1)
  expect(opening).not.toHaveBeenCalled()
  expect(h.engine.journal.projection.keepalive.get(h.sessionId)).toMatchObject({ source: 'auto', phase: 'renewed' })
  vi.setSystemTime(Date.now() + 56 * 60000); await h.engine.drive(); await h.engine.drive()
  expect(h.cache.calls).toHaveLength(2)
  expect(h.creates).toEqual([h.sessionId])
})
it.each(['disabled', 'busy', 'child', 'job', 'closed', 'budget'] as const)('A28 stops automatic renewal for %s', async (reason) => {
  const h = await setup()
  if (reason === 'disabled') {
    const definition = h.definitions.get(seat)
    if (definition) definition.autoKeepAlive = false
  } else if (reason === 'closed') await h.engine.recordClosed({ sessionId: h.sessionId, phase: 'closed', reason: 'manual',
    stateVersion: 2, endedAt: new Date().toISOString(), reportId: null, selfReport: null, selfReportStatus: 'not-submitted' })
  else {
    const list = h.seatProvider.list
    h.seatProvider.list = async () => {
      const page = await list()
      return page.status !== 'listed' ? page : { ...page, sessions: page.sessions.map(window => ({ ...window,
        status: reason === 'busy' ? 'running' : window.status,
        runningSubagents: reason === 'child' ? 1 : 0, activeJobs: reason === 'job' ? 1 : 0,
        engineStatus: reason === 'budget' ? 'budget-stopped' : window.engineStatus })) }
    }
  }
  vi.setSystemTime(Date.now() + 56 * 60000); await h.engine.drive()
  expect(h.cache.calls).toEqual([])
})
it.each(['ttl-too-short', 'evidence-unavailable'] as const)('records %s rather than dispatching speculative renewal', async (reason) => {
  const h = await setup(reason === 'ttl-too-short' ? 300 : 3600)
  if (reason === 'evidence-unavailable') h.cache.evidence = { kind: 'unknown' }
  vi.setSystemTime(Date.now() + 60000); await h.engine.drive(); await h.engine.drive()
  expect(h.cache.calls).toEqual([])
  const skipped = h.engine.journal.projection.decisions.flatMap(item => item.effects)
    .filter(item => item.kind === 'cache/keepalive-skipped')
  expect(skipped).toHaveLength(1)
  expect(skipped[0]).toMatchObject({ data: { source: 'auto', phase: 'skipped', reason } })
})
it('recomputes after restart and never catches up a missed renewal deadline', async () => {
  const h = await setup(); await h.engine.shutdown()
  vi.setSystemTime(Date.now() + 57 * 60000)
  const restarted = await h.start(); await restarted.drive(); await restarted.drive()
  expect(h.cache.calls).toEqual([])
  expect(restarted.journal.projection.keepalive.get(h.sessionId)).toMatchObject({ reason: 'missed-due', phase: 'skipped' })
})
it('manual renewal shares the durable path and remains deduplicated after newer operations and restart', async () => {
  const h = await setup()
  const definition = h.definitions.get(seat)
  if (definition) definition.autoKeepAlive = false
  const request = { sessionId: h.sessionId, operationId: 'manual-a' as T.SeatOperationId }
  expect(await h.engine.renew(request)).toMatchObject({ status: 'renewed' })
  await h.engine.renew({ ...request, operationId: 'manual-b' as T.SeatOperationId })
  await h.engine.shutdown(); const restarted = await h.start()
  expect(await restarted.renew(request)).toMatchObject({ status: 'renewed' })
  expect(h.cache.calls).toEqual(['manual-a', 'manual-b'])
  expect([...restarted.journal.projection.renewals.values()].every(item => item.source === 'manual')).toBe(true)
})
it('retains an uncertain attempted renewal across restart without redispatch', async () => {
  const h = await setup()
  const { fact } = await import('../src/triggers.ts')
  await h.engine.journal.commit(() => [fact({ kind: 'cache/keepalive', data: { sessionId: h.sessionId,
    operationId: 'manual-a' as T.SeatOperationId, source: 'manual', phase: 'attempted', reason: null,
    evidenceAt: Date.now(), dueAt: null, observedAt: new Date().toISOString() } })])
  await h.engine.shutdown(); const restarted = await h.start()
  expect(await restarted.renew({ sessionId: h.sessionId, operationId: 'manual-a' as T.SeatOperationId }))
    .toMatchObject({ status: 'uncertain', error: { code: 'renewal-uncertain' } })
  expect(h.cache.calls).toEqual([])
})
