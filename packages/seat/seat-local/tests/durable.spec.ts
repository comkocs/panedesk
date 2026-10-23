import { describe, expect, it } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { LocalEngineState } from '../src/engine-state.ts'
import { ReportStore, latestReport } from '../src/report-store.ts'
import { WaitStore } from '../src/wait-store.ts'
import { WaitCoordinator } from '../src/wait.ts'
import { nodeId, operation } from './fixtures.ts'

const sessionId = 'owner-a' as SessionId
const authority: T.SeatCallContext = { principalId: 'principal-a' as T.SeatPrincipalId, origin: 'manual', nodeId }
function journal() {
  const decisions: T.EngineDecision[] = []
  const engine: Pick<T.SeatEngineService, 'query' | 'transact'> = {
    query: () => Promise.resolve({ effects: decisions.flatMap(item => item.effects), complete: true, watermark: decisions.length }),
    transact: (request) => {
      if (request.expectedSequence !== decisions.length) return Promise.resolve({ status: 'conflict', actualSequence: decisions.length })
      decisions.push(structuredClone(request.decision))
      return Promise.resolve({ status: 'committed', decision: request.decision })
    },
  }
  return { decisions, reopen: () => new LocalEngineState(() => engine, nodeId, 100, 10) }
}
function report(stateVersion: number): T.CloseSelfReport {
  return { reportId: `report-${stateVersion}` as T.CloseReportId, sessionId, canClose: true, waitingFor: [],
    nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, submittedAt: '2026-01-01T00:00:00.000Z', stateVersion }
}
const objects: T.WaitObject[] = [
  { kind: 'job', id: 'job-a' as Extract<T.WaitObject, { kind: 'job' }>['id'] },
  { kind: 'schedule', id: 'schedule-a' as Extract<T.WaitObject, { kind: 'schedule' }>['id'] },
  { kind: 'subagent', id: 'child-a' as Extract<T.WaitObject, { kind: 'subagent' }>['id'] },
  { kind: 'message', id: 'mail-a' as Extract<T.WaitObject, { kind: 'message' }>['id'] },
]
const request: T.RegisterSeatWaitRequest = { waitId: 'wait-a' as T.WaitId, sessionId, mode: 'all', objects,
  operationId: operation('wait-a') }
const observation = (object: T.WaitObject, outcome: T.WaitObservation['outcome'] = 'completed'): T.WaitObservation => ({
  object, outcome, watermark: 2, observedAt: '2026-01-01T00:00:01.000Z', durability: 'durable',
})

describe('report and wait recovery from engine facts', () => {
  it('revokes the original report after store reconstruction and rejects stale overwrites', async () => {
    const backend = journal()
    const initial = new ReportStore(backend.reopen())
    const value = report(1)
    expect(await initial.submit({ report: value, operationId: operation('report') }, authority))
      .toEqual({ status: 'recorded', reportId: value.reportId, stateVersion: 1 })
    const recovered = new ReportStore(backend.reopen())
    const revoke = { sessionId, reportId: value.reportId, expectedStateVersion: 1, operationId: operation('revoke') }
    expect(await recovered.revoke(revoke, authority)).toEqual({ status: 'revoked', reportId: value.reportId, stateVersion: 2 })
    expect(await recovered.revoke(revoke, authority)).toEqual({ status: 'revoked', reportId: value.reportId, stateVersion: 2 })
    expect(await recovered.submit({ report: value, operationId: operation('late-report') }, authority))
      .toMatchObject({ status: 'rejected', error: { code: 'state-conflict' } })
    expect(latestReport((await backend.reopen().read()).effects, sessionId)).toBeNull()
    expect(backend.decisions).toHaveLength(2)
  })

  it('commits only one concurrent report at the same version and rejects the other', async () => {
    const backend = journal()
    const first = new ReportStore(backend.reopen()), second = new ReportStore(backend.reopen())
    const results = await Promise.all([
      first.submit({ report: report(1), operationId: operation('first') }, authority),
      second.submit({ report: { ...report(1), canClose: false }, operationId: operation('second') }, authority),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['recorded', 'rejected'])
    expect(backend.decisions).toHaveLength(1)
  })

  it('settles only after all four objects complete and ignores unknown or repeated watermarks', async () => {
    const backend = journal()
    const store = new WaitStore(backend.reopen())
    await store.register(request)
    for (const object of objects) await store.observe(request.waitId, { ...observation(object, 'unknown'), watermark: 1 })
    expect((await store.read(request.waitId))?.phase).toBe('registered')
    for (const object of objects.slice(0, 3)) await store.observe(request.waitId, observation(object))
    expect((await store.read(request.waitId))?.phase).toBe('registered')
    const last = objects[3]
    if (last === undefined) throw new Error('Missing fixture object')
    const satisfied = await store.observe(request.waitId, observation(last))
    expect(satisfied.phase).toBe('satisfied')
    expect(await store.observe(request.waitId, observation(last))).toEqual(satisfied)
    const recovered = new WaitStore(backend.reopen())
    expect(await recovered.cancel({ waitId: request.waitId, sessionId, expectedStateVersion: satisfied.stateVersion,
      operationId: operation('cancel') })).toEqual({ status: 'already-settled', wait: satisfied })
  })

  it('reuses the original wake identity after coordinator recovery and does not resend delivered wakes', async () => {
    const backend = journal()
    let store = new WaitStore(backend.reopen())
    await store.register({ ...request, mode: 'any' })
    const object = objects[0]
    if (object === undefined) throw new Error('Missing fixture object')
    const satisfied = await store.observe(request.waitId, observation(object))
    store = new WaitStore(backend.reopen())
    const sent: T.SeatOperationId[] = []
    const coordinator = new WaitCoordinator({ authorize: () => Promise.resolve(null), register: value => store.register(value),
      read: id => store.read(id), observe: (id, value) => store.observe(id, value), cancel: value => store.cancel(value),
      snapshot: () => Promise.resolve(null), subscribe: () => () => Promise.resolve(),
      wake: async (wait) => { sent.push(wait.wakeOperationId); await store.woken(wait.waitId) },
    })
    await coordinator.watch(satisfied)
    const woken = await store.read(request.waitId)
    if (woken === null) throw new Error('Missing durable wait')
    await coordinator.watch(woken)
    expect(sent).toEqual([operation('wait-a:wake')])
    expect(woken.phase).toBe('woken')
    await coordinator.dispose()
  })
})
