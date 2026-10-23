/** Close reminders retain one durable identity across competing evaluations. */
import { expect, it, vi } from 'vitest'
import { agentEvents } from '@panedesk/dsh-agent'
import type { JobOutcome } from '@panedesk/dsh-jobs'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { LocalSeatService } from '../src/service.ts'
import { completesTurn, insertsInput, inputContains } from '../../seat/tests/completion.ts'

it('delivers one complete close reminder through concurrent submission and scheduled reevaluation', async () => {
  const f = await admissionHost()
  const done = Promise.withResolvers<JobOutcome>()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('reminder-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    const agent = f.ctx.agents.get(opened.sessionId)!
    const service = f.ctx.get('seats')
    if (!(service instanceof LocalSeatService)) throw new Error('Local seats are unavailable')
    const offAdmission = f.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Inspect close reminder input.' }))
    const detach = f.ctx.get('jobs')!.attachController('reminder-test')
    const jobId = f.ctx.get('jobs')!.start({ kind: 'bash', label: 'Pending work', owner: agent.id,
      run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }) })
    const ticketId = 'reminder-child' as T.ChildTicketId
    await f.engine.admitChild({ maxActive: 1, ticket: { ticketId, parentSessionId: agent.id, sequence: 0,
      requestDigest: 'reminder-child' as T.SeatDigest, agentPreset: f.definition.agentPreset,
      permissionRevision: 1, phase: 'queued', childSessionId: null, ownerEpoch: 'reminder-owner' as T.OwnerEpoch,
      stateVersion: 0 } })
    const listed = await f.seats.list({})
    if (listed.status !== 'listed') throw new Error(JSON.stringify(listed))
    const summaries = listed.sessions[0]!.busyReasons.map(reason => reason.summary)
    expect(summaries).toContain(`job: ${jobId}`)
    expect(summaries).toContain(`ticket: ${ticketId}`)
    const evaluated = Promise.withResolvers<undefined>()
    const evaluate = service.reevaluateReport.bind(service)
    const observer = vi.spyOn(service, 'reevaluateReport').mockImplementation(async (id) => {
      try { await evaluate(id) } finally { evaluated.resolve(undefined) }
    })
    const offReport = f.ctx.on('seat/decision', (decision) => {
      if (decision.effects.some(effect => effect.kind === 'report/submitted')) {
        agentEvents(f.ctx, agent).emit('agent/status', { status: 'idle' })
      }
    })
    const delivery = f.ctx.get('messageDelivery')!
    const sent = vi.spyOn(delivery, 'send')
    const report: T.CloseSelfReport = { reportId: 'reminder-report' as T.CloseReportId, sessionId: agent.id,
      canClose: true, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] },
      submittedAt: new Date().toISOString(), stateVersion: 1 }
    const request = { report, operationId: operation('reminder-submit') }
    const started = performance.now()
    await insertsInput(f.ctx, agent.id, inputContains('This window still has pending work:'), async () => {
      expect(await f.seats.submitReport(request)).toMatchObject({ status: 'recorded' })
      await evaluated.promise
    })
    const milliseconds = performance.now() - started
    expect(milliseconds).toBeLessThan(5000)
    const reminders = () => sent.mock.calls.filter(([request]) => request.content.startsWith('This window still has pending work:'))
    expect(reminders()).toHaveLength(1)
    expect(reminders()[0]![0].content).toBe(`This window still has pending work: ${summaries.join('; ')}`)
    expect(reminders()[0]![0]).toMatchObject({ messageClass: 'handoff', priority: 'steer' })
    await Promise.all([service.reevaluateReport(agent.id), service.reevaluateReport(agent.id), f.seats.submitReport(request)])
    expect(reminders()).toHaveLength(1)
    offReport(); observer.mockRestore()
    const restored = await f.reload()
    if (!(restored instanceof LocalSeatService)) throw new Error('Reloaded seats are unavailable')
    await restored.recover()
    await restored.reevaluateReport(agent.id)
    expect(reminders()).toHaveLength(1)
    const events = agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('This window still has pending work:'))
    expect(events).toHaveLength(1)
    process.stdout.write(`${JSON.stringify({ name: 'concurrent close reminder', copies: reminders().length, milliseconds,
      reasons: summaries.length })}\n`)
    await restored.revokeReport({ reportId: report.reportId, sessionId: agent.id, expectedStateVersion: 1,
      operationId: operation('reminder-revoke') })
    await f.engine.releaseChild(ticketId)
    await completesTurn(f.ctx, agent.id, inputContains('This window still has pending work:'), async () => {
      offAdmission()
      if (!agent.wake) throw new Error('Reminder agent cannot wake')
      agent.wake()
    })
    const delivered = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && inputContains('This window still has pending work:')(event.data))
    expect(delivered).toHaveLength(1)
    if (delivered[0]?.type !== 'user/message') throw new Error('Reminder did not enter the Session')
    expect(delivered[0].data.content).toEqual([{ type: 'text',
      text: `This window still has pending work: ${summaries.join('; ')}` }])
    detach()
  } finally { done.resolve({ status: 'killed' }); vi.restoreAllMocks(); await f.close() }
}, 20000)
