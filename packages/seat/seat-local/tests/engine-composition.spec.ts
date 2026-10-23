/** Local ingress and close barriers against the real engine journal. */
import { expect, it, vi } from 'vitest'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { LocalCloser, closingState } from '../src/closing-service.ts'
import { ReportStore } from '../src/report-store.ts'
import type * as T from '@panedesk/dsh-seat'

it('reuses real manual admission and records one manual renewal attempt before maintenance', async () => {
  const f = await engineFixture()
  try {
    const opened = await f.open()
    expect(opened.status).toBe('opened')
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    expect(await f.open()).toMatchObject({ status: 'opened', sessionId: opened.sessionId })
    expect(f.created).toHaveLength(1)
    const request = { sessionId: opened.sessionId, operationId: operation('manual-renew') }
    const maintenance = f.dependencies.keepalive
    if (!maintenance) throw new Error('Maintenance is unavailable')
    const renew = maintenance.renew.bind(maintenance)
    maintenance.renew = async (sessionId, operationId) => {
      expect((await f.state.read()).effects.findLast(effect => effect.kind === 'cache/keepalive')?.data)
        .toMatchObject({ phase: 'attempted', operationId, source: 'manual' })
      return renew(sessionId, operationId)
    }
    expect(await f.engine.renew(request)).toMatchObject({ status: 'renewed' })
    expect(await f.engine.renew(request)).toMatchObject({ status: 'renewed' })
    expect(f.renewals).toEqual([request.operationId])
    const facts = (await f.state.read()).effects.filter(effect => effect.kind === 'cache/keepalive')
    expect(facts.map(effect => effect.data)).toMatchObject([
      { source: 'manual', phase: 'attempted', operationId: request.operationId },
      { source: 'manual', phase: 'renewed', operationId: request.operationId },
    ])
    let interruptedCalls = 0
    maintenance.renew = async () => { interruptedCalls++; throw new Error('Maintenance outcome lost') }
    const interrupted = { ...request, operationId: operation('manual-interrupted') }
    expect(await f.engine.renew(interrupted)).toMatchObject({ status: 'uncertain' })
    expect(await f.engine.renew(interrupted)).toMatchObject({ status: 'uncertain' })
    expect(interruptedCalls).toBe(1)
  } finally { await f.close() }
})

it('releases a pre-archive failure barrier without publishing a terminal window or releasing capacity', async () => {
  const f = await engineFixture()
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
    const reports = new ReportStore(f.state)
    const authority: T.SeatCallContext = { principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId }
    const report: T.CloseSelfReport = { reportId: 'report-close' as T.CloseReportId, sessionId: opened.sessionId,
      canClose: true, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] },
      submittedAt: new Date().toISOString(), stateVersion: 1 }
    expect(await reports.submit({ report, operationId: operation('submit-close') }, authority)).toMatchObject({ status: 'recorded' })
    await expect(closer.close({ sessionId: opened.sessionId, operationId: operation('close-a'), expectedStateVersion: 1 }, report))
      .rejects.toThrow('Close providers are unavailable')
    const facts = (await f.state.read()).effects
    expect(closingState(facts, opened.sessionId)).toMatchObject({ phase: 'admission', barrierReleased: true })
    expect(facts.filter(effect => effect.kind === 'window/closed' || effect.kind === 'resource/released')).toHaveLength(0)
    expect(await reports.revoke({ sessionId: opened.sessionId, reportId: report.reportId, expectedStateVersion: 1,
      operationId: operation('revoke-close') }, authority)).toMatchObject({ status: 'revoked', stateVersion: 2 })
    expect(await f.open('second-open')).toMatchObject({ status: 'rejected', error: { code: 'seat-already-open' } })
    await closer.drain()
  } finally { await f.close() }
})

it('publishes real close accounting only after archive, title and Session persistence flush', async () => {
  const f = await engineFixture(true)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    const persistence = f.ctx.get('sessionPersistence')
    if (!persistence) throw new Error('Persistence did not load')
    const flush = vi.spyOn(persistence, 'flush')
    const record = vi.spyOn(f.engine, 'recordClosed')
    const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
    const request = { sessionId: opened.sessionId, operationId: operation('close-durable'), expectedStateVersion: 1 }
    const result = await closer.close(request)
    expect(result.status).toBe('closed')
    expect(await closer.close(request)).toEqual(result)
    expect(record).toHaveBeenCalledOnce()
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0] ?? 0)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(opened.sessionId)
    const session = f.ctx.sessions.get(opened.sessionId)
    if (!session) throw new Error('Closed Session disappeared')
    expect(f.ctx.sessionTitle.get(session)?.title).toBe(`${opened.title} closed`)
    expect((await f.state.read()).effects.filter(effect => effect.kind === 'resource/released')).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('retains the post-archive barrier and resumes flush before releasing the original capacity', async () => {
  const f = await engineFixture(true)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Opening did not create a window')
    const request = { sessionId: opened.sessionId, operationId: operation('close-recover'), expectedStateVersion: 1 }
    const flush = vi.spyOn(f.ctx.sessionPersistence, 'flush').mockRejectedValueOnce(new Error('Flush interrupted'))
    const first = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
    await expect(first.close(request)).rejects.toThrow('Flush interrupted')
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(opened.sessionId)
    const facts = (await f.state.read()).effects
    expect(closingState(facts, opened.sessionId)).toMatchObject({ phase: 'admission', operationId: request.operationId })
    expect(closingState(facts, opened.sessionId)?.barrierReleased).not.toBe(true)
    expect(facts.filter(effect => effect.kind === 'window/closed' || effect.kind === 'resource/released')).toHaveLength(0)
    await first.drain()
    const recovered = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
    expect(await recovered.close(request)).toMatchObject({ status: 'closed' })
    expect(flush).toHaveBeenCalledTimes(2)
    expect((await f.state.read()).effects.filter(effect => effect.kind === 'resource/released')).toHaveLength(1)
    await recovered.drain()
  } finally { vi.restoreAllMocks(); await f.close() }
})
