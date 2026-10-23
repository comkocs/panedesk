/** Exact-owner wait observations retain durable authorization without a global Session scan. */
import { expect, it, vi } from 'vitest'
import type { JobId } from '@panedesk/dsh-jobs'
import type { WaitId, WaitObject } from '@panedesk/dsh-seat'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { WaitStore } from '../src/wait-store.ts'
import { WaitCoordinator } from '../src/wait.ts'
import { commitsEffect } from '../../seat/tests/completion.ts'
import { localFact } from '../src/engine-state.ts'
import type { OwnerEpoch } from '@panedesk/dsh-seat'
import { SubagentRunId } from '@panedesk/dsh-subagent'

it('authorizes a durable job and observes settlement within five seconds without listing unrelated sessions', async () => {
  const f = await engineFixture(true)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    const session = f.ctx.sessions.get(opened.sessionId)
    if (!session) throw new Error('Session did not load')
    const job = { jobId: 'job-a' as JobId, owner: session.id, kind: 'test', label: 'Observed job', startedAt: Date.now() }
    session.append('job/registered', job)
    await expect(f.ctx.sessions.flush(session)).resolves.toBe(true)
    const object: WaitObject = { kind: 'job', id: job.jobId }
    const request = { waitId: 'wait-job' as WaitId, sessionId: session.id, mode: 'all' as const,
      objects: [object], operationId: operation('wait-job') }
    const query = f.ctx.sessionQuery
    const list = vi.spyOn(query, 'listSessions')
    const read = vi.spyOn(query, 'readSession')
    const store = new WaitStore(f.state)
    const sent: number[] = []
    const coordinator = new WaitCoordinator({ authorize: f.runtime.authorizeWait,
      register: request => store.register(request), read: id => store.read(id), observe: (id, value) => store.observe(id, value),
      cancel: request => store.cancel(request), snapshot: f.runtime.snapshot, subscribe: f.runtime.subscribe,
      wake: async (wait) => { sent.push(performance.now()); await store.woken(wait.waitId) } })
    try {
      expect(await coordinator.register(request)).toMatchObject({ status: 'registered', wait: { phase: 'registered' } })
      const started = performance.now()
      await commitsEffect(f.ctx, effect => effect.kind === 'wait/woken' && effect.data.waitId === request.waitId, async () => {
        session.append('job/settled', { ...job, finishedAt: Date.now(), status: 'completed', cause: 'producer', producerReported: true })
        await expect(f.ctx.sessions.flush(session)).resolves.toBe(true)
      })
      expect((await store.read(request.waitId))?.phase).toBe('woken')
      expect(sent).toHaveLength(1)
      const elapsed = (sent[0] ?? Infinity) - started
      expect(elapsed).toBeLessThanOrEqual(5000)
      expect(list).not.toHaveBeenCalled()
      expect(read.mock.calls.every(([id]) => id === session.id)).toBe(true)
      console.info(JSON.stringify({ elapsedMs: elapsed, sessionReads: read.mock.calls.length, globalScans: list.mock.calls.length }))
      await coordinator.dispose()
      await f.runtime.drainObservations?.()
      const count = read.mock.calls.length
      session.append('job/settled', { ...job, finishedAt: Date.now(), status: 'completed', cause: 'producer', producerReported: true })
      await expect(f.ctx.sessions.flush(session)).resolves.toBe(true)
      await f.runtime.drainObservations?.()
      expect(read.mock.calls).toHaveLength(count)
    } finally { await coordinator.dispose(); await f.runtime.drainObservations?.() }
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('keeps the latest child run pending when an earlier settlement is replayed', async () => {
  const f = await engineFixture(true)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Missing parent window')
    const object: WaitObject = { kind: 'subagent', id: SubagentRunId('child-session') }
    const observe = (epoch: string, phase: 'running' | 'settled', watermark: number) => localFact({
      kind: 'job/observed', sessionId: opened.sessionId,
      data: { sessionId: opened.sessionId, ownerEpoch: epoch as OwnerEpoch, phase, observation: { object,
        outcome: phase === 'running' ? 'unknown' : 'completed', watermark,
        observedAt: new Date().toISOString(), durability: 'durable' } },
    })
    await f.state.mutate(() => ({ result: undefined, effects: [observe('run-a', 'running', 1),
      observe('run-a', 'settled', 2), observe('run-b', 'running', 3), observe('run-a', 'settled', 4)] }))
    expect(await f.runtime.snapshot(object)).toBeNull()
    await f.state.mutate(() => ({ result: undefined, effects: [observe('run-b', 'settled', 5)] }))
    expect(await f.runtime.snapshot(object)).toMatchObject({ object, outcome: 'completed', watermark: 5 })
  } finally { await f.close() }
})
