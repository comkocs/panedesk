/** Loader worker exposes reminder durability barriers to its owning test. */
import assert from 'node:assert/strict'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { LocalSeatService } from '../src/service.ts'

const [root, phase] = process.argv.slice(2)
if (!root || !phase) throw new Error('Missing reminder recovery arguments')
const f = await admissionHost(root)
f.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Inspect recovered reminder.' }))
const service = f.ctx.get('seats')
if (!(service instanceof LocalSeatService)) throw new Error('Local seats are unavailable')
const barrier = () => {
  process.send?.({ kind: 'barrier', pid: process.pid })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
try {
  if (phase !== 'recover') {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('process-reminder-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    await f.engine.admitChild({ maxActive: 1, ticket: { ticketId: 'process-child' as T.ChildTicketId,
      parentSessionId: opened.sessionId, sequence: 0, requestDigest: 'process-child' as T.SeatDigest,
      agentPreset: f.definition.agentPreset, permissionRevision: 1, phase: 'queued', childSessionId: null,
      ownerEpoch: 'process-owner' as T.OwnerEpoch, stateVersion: 0 } })
    if (phase === 'pending') f.ctx.on('domain/changed', (event) => {
      if (event.domain === 'seat_close_reminders') barrier()
    })
    else {
      const delivery = f.ctx.get('messageDelivery')!
      const send = delivery.send.bind(delivery)
      delivery.send = async (request) => {
        const result = await send(request)
        if (request.content.startsWith('This window still has pending work:')) barrier()
        return result
      }
    }
    await f.seats.submitReport({ report: { reportId: 'process-report' as T.CloseReportId, sessionId: opened.sessionId,
      canClose: true, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] },
      submittedAt: new Date().toISOString(), stateVersion: 1 }, operationId: operation('process-reminder-submit') })
    await new Promise<never>(() => {})
  }
  const started = performance.now()
  const effects = (await f.state.read()).effects
  const report = effects.find(effect => effect.kind === 'report/submitted')
  if (report?.kind !== 'report/submitted') throw new Error('Report did not survive restart')
  const sessionId = report.data.report.sessionId
  await service.recover()
  await Promise.all([service.reevaluateReport(sessionId), service.reevaluateReport(sessionId)])
  const page = await f.ctx.messageDelivery.list({ targetSessionId: sessionId })
  assert.equal(page.complete, true)
  assert.equal(page.items.length, 1)
  const milliseconds = performance.now() - started
  process.send?.({ kind: 'recovered', copies: page.items.length, milliseconds, pid: process.pid })
  process.on('message', (message: unknown) => {
    if (message === 'stop') void f.close().then(() => { process.disconnect?.() })
  })
} catch (error) { await f.close(); throw error }
