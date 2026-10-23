/** Model calls use self-owned authority through real local providers and the Loader. */
import { expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type { CloseReportId, WaitId } from '@panedesk/dsh-seat'
import { CreationAdapter } from '../../seat-local/tests/creation-provider.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { localHost } from './local-host.ts'

class ToolModel extends CreationAdapter {
  calls: { name: string; arguments: object }[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = this.calls.shift()
    if (!call) { yield* super.stream(options); return }
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`model-${this.requests.length}`),
      name: call.name, arguments: JSON.stringify(call.arguments) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('authorizes model waits and reports only for the calling session and refuses other-session mutations', async () => {
  const model = new ToolModel()
  const f = await localHost(model)
  try {
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    expect(await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row),
      expectedRevision: 0, operationId: operation('import') })).toMatchObject({ status: 'committed' })
    const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', operationId: operation('open'), openingMode: 'prefill' })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    const agent = f.ctx.agents.get(opened.sessionId)!
    const report = { canClose: false, waitingFor: [], nextOpen: { when: { kind: 'unspecified' as const }, prerequisites: [] }, stateVersion: 1 }
    model.calls.push({ name: 'seat_report', arguments: report })
    const message = await f.ctx.get('messageDelivery')!.send({ target: { sessionId: agent.id }, priority: 'queue', messageClass: 'handoff', operationId: 'message-report' as OperationId, content: 'Record a report.' })
    await expect.poll(() => model.requests.length).toBe(2)
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    const facts = await f.ctx.get('seatEngine')!.query({ limit: 1000 })
    expect(facts.effects.filter(effect => effect.kind === 'report/submitted'),
      JSON.stringify((await f.ctx.sessionQuery.readSession(agent.id)).events.filter(event => event.type === 'tool/result')))
      .toMatchObject([{ kind: 'report/submitted', data: {
        principalId: `session:${agent.id}`, report: { sessionId: agent.id, canClose: false },
      } }])
    model.calls.push({ name: 'seat_wait', arguments: { mode: 'all', objects: [{ kind: 'message', id: message.messageId }] } })
    await f.ctx.get('messageDelivery')!.send({ target: { sessionId: agent.id }, priority: 'queue', messageClass: 'handoff', operationId: 'message-wait' as OperationId, content: 'Register the observed wait.' })
    await expect.poll(async () => (await f.ctx.get('seatEngine')!.query({ limit: 1000 })).effects
      .some(effect => effect.kind === 'wait/registered' && effect.data.sessionId === agent.id)).toBe(true)
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    const events = (await f.ctx.sessionQuery.readSession(agent.id)).events
    expect(JSON.stringify(events)).toContain('recorded')
    expect(JSON.stringify(events)).toContain('registered')
    const access = f.ctx.get('seatLocalSession')!.forSession(agent.session)
    expect(Object.keys(access).sort()).toEqual(['cancelWait', 'registerWait', 'revokeReport', 'submitReport'])
    const recorded = facts.effects.find(effect => effect.kind === 'report/submitted')
    if (recorded?.kind !== 'report/submitted') throw new Error('Missing own report')
    const latest = await f.ctx.get('seatEngine')!.query({ limit: 1000 })
    const waited = latest.effects.findLast(effect => effect.kind === 'wait/registered' || effect.kind === 'wait/satisfied' || effect.kind === 'wait/woken')
    if (!waited || !('waitId' in waited.data)) throw new Error('Missing own wait')
    model.calls.push({ name: 'seat_cancel_wait', arguments: { waitId: waited.data.waitId, expectedStateVersion: waited.data.stateVersion } },
      { name: 'seat_revoke_report', arguments: { reportId: recorded.data.report.reportId, expectedStateVersion: 1 } })
    await f.ctx.get('messageDelivery')!.send({ target: { sessionId: agent.id }, priority: 'queue', messageClass: 'handoff',
      operationId: 'message-revoke' as OperationId, content: 'Cancel the wait and revoke the report.' })
    await expect.poll(async () => (await f.ctx.get('seatEngine')!.query({ limit: 1000 })).effects.some(effect => effect.kind === 'report/revoked')).toBe(true)
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    expect(JSON.stringify((await f.ctx.sessionQuery.readSession(agent.id)).events)).toMatch(/already-settled|cancelled/)
    const other = SessionId('session-b')
    const waitId = 'wait-b' as WaitId
    const reportId = 'report-b' as CloseReportId
    for (const result of await Promise.all([
      access.registerWait({ sessionId: other, waitId, operationId: operation('foreign-wait'), mode: 'all', objects: [{ kind: 'message', id: message.messageId }] }),
      access.cancelWait({ sessionId: other, waitId, expectedStateVersion: 1, operationId: operation('foreign-cancel') }),
      access.submitReport({ report: { ...report, sessionId: other, reportId, submittedAt: new Date().toISOString() }, operationId: operation('foreign-report') }),
      access.revokeReport({ sessionId: other, reportId, expectedStateVersion: 1, operationId: operation('foreign-revoke') }),
    ])) expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    await expect(f.ctx.get('seats')!.registerWait({ sessionId: agent.id, waitId, operationId: operation('external'),
      mode: 'all', objects: [{ kind: 'message', id: message.messageId }] })).rejects.toThrow('Verified authority is required.')
    expect(await f.seats.submitReport({ report: { ...report, sessionId: other, reportId,
      submittedAt: new Date().toISOString() }, operationId: operation('other-report') })).toMatchObject({ status: 'recorded' })
    model.calls.push({ name: 'seat_cancel_wait', arguments: { waitId, expectedStateVersion: 1 } },
      { name: 'seat_revoke_report', arguments: { reportId, expectedStateVersion: 1 } })
    const requestCount = model.requests.length
    await f.ctx.get('messageDelivery')!.send({ target: { sessionId: agent.id }, priority: 'queue', messageClass: 'handoff',
      operationId: 'message-foreign' as OperationId, content: 'Attempt the supplied foreign identities.' })
    await expect.poll(() => model.requests.length).toBe(requestCount + 3)
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    const foreignResults = JSON.stringify((await f.ctx.sessionQuery.readSession(agent.id)).events.filter(event => event.type === 'tool/result'))
    expect(foreignResults).toContain('wait-object-not-found')
    expect(foreignResults).toContain('state-conflict')
    await f.unmount()
    expect(f.ctx.get('seatLocalSession')).toBeUndefined()
    expect(await access.revokeReport({ sessionId: agent.id, reportId, expectedStateVersion: 1,
      operationId: operation('unloaded-revoke') })).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
  } finally { await f.close() }
}, 30000)
