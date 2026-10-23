/** Durable job settlement wakes a real model turn through the installed seat service and M5. */
import { expect, vi } from 'vitest'
import type { JobId } from '@panedesk/dsh-jobs'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import type { engineFixture } from './engine-fixture.ts'
import type { CreationAdapter } from './creation-provider.ts'
import { operation } from './fixtures.ts'

/** Measure persistence-to-model consumption without scanning unrelated Sessions.
 * @param f - real engine and local provider composition.
 * @param sessionId - live waiting owner.
 * @param adapter - deterministic external model transport.
 * @param unload - unload the local provider and return its Loader restoration operation.
 */
export async function checkWaitDelivery(f: Awaited<ReturnType<typeof engineFixture>>, sessionId: SessionId,
  adapter: CreationAdapter, unload: () => Promise<() => Promise<void>>): Promise<void> {
  const agent = f.ctx.agents.get(sessionId)
  const service = f.ctx.get('seats')
  if (!agent || !service) throw new Error('Waiting owner is unavailable')
  const seats = service.withAuthority({ principalId: 'wait-owner' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId })
  const job = { jobId: 'durable-cold-job' as JobId, owner: sessionId, kind: 'test', label: 'Durable job', startedAt: Date.now() }
  agent.session.append('job/registered', job)
  await f.ctx.sessions.flush(agent.session)
  const request: T.RegisterSeatWaitRequest = { waitId: 'wait-delivery' as T.WaitId, sessionId, mode: 'all',
    objects: [{ kind: 'job', id: job.jobId }], operationId: operation('wait-delivery') }
  const list = vi.spyOn(f.ctx.sessionQuery, 'listSessions')
  const reads = vi.spyOn(f.ctx.sessionQuery, 'readSession')
  try {
    expect(f.ctx.get('jobs')).toBeUndefined()
    expect(await seats.registerWait(request)).toMatchObject({ status: 'registered', wait: { phase: 'registered' } })
    const before = adapter.requests.length
    const restore = await unload()
    expect(f.ctx.get('seats')).toBeUndefined()
    const stoppedReads = reads.mock.calls.length
    const started = performance.now()
    agent.session.append('job/settled', { ...job, finishedAt: Date.now(), status: 'completed', cause: 'producer', producerReported: true })
    await f.ctx.sessions.flush(agent.session)
    expect(reads.mock.calls).toHaveLength(stoppedReads)
    expect(adapter.requests).toHaveLength(before)
    await restore()
    await expect.poll(() => adapter.requests.length, { timeout: 4000 }).toBe(before + 1)
    const elapsedMs = performance.now() - started
    expect(elapsedMs).toBeLessThanOrEqual(5000)
    expect(JSON.stringify(adapter.requests[before])).toContain('Wait wait-delivery: job durable-cold-job: completed')
    await agent.whenIdle()
    await expect.poll(async () => (await seats.wait(request.waitId))?.phase).toBe('woken')
    expect(list).not.toHaveBeenCalled()
    expect(reads.mock.calls.every(([id]) => id === sessionId)).toBe(true)
    console.info(JSON.stringify({ elapsedMs, sessionReads: reads.mock.calls.length, globalScans: list.mock.calls.length,
      modelTurns: adapter.requests.length - before }))
    const restored = f.ctx.get('seats')?.withAuthority({ principalId: 'wait-owner' as T.SeatPrincipalId,
      origin: 'manual', nodeId: f.options.nodeId })
    expect(await restored?.registerWait(request)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
    expect(adapter.requests).toHaveLength(before + 1)
  } finally { list.mockRestore(); reads.mockRestore() }
}
