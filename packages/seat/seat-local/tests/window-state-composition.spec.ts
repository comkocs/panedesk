/** Live work and engine admission remain independent columns in window projections. */
import { expect, it, vi } from 'vitest'
import type { AskUserQuestionAnswer } from '@panedesk/dsh-user-questions'
import type { ApprovalOutcome } from '@panedesk/dsh-user-approval'
import { localFact } from '../src/engine-state.ts'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'
import type * as T from '@panedesk/dsh-seat'
import type { JobOutcome } from '@panedesk/dsh-jobs'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { recordCost } from './ledger-call.ts'

it('rejects manual renewal while a real background job owns work and reports its identity', async () => {
  const f = await admissionHost()
  const done = Promise.withResolvers<JobOutcome>()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('busy-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    f.ctx.get('jobs')!.attachController('test-observer')
    const id = f.ctx.get('jobs')!.start({ kind: 'bash', label: 'Background work', owner: opened.sessionId,
      run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }) })
    const result = await f.seats.renew({ sessionId: opened.sessionId, operationId: operation('busy-renew') })
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'session-busy' } })
    if (result.status !== 'rejected') throw new Error('Busy renewal was admitted')
    expect(result.error.message).toContain(id)
    expect(f.renewals).toEqual([])
    expect(f.adapter.requests).toEqual([])
    const listed = await f.seats.list({})
    expect(listed).toMatchObject({ sessions: [{ status: 'idle', activeJobs: 1, canRenew: false,
      busyReasons: [{ kind: 'job', objectId: id }] }] })
    const settled = Promise.withResolvers<undefined>()
    const off = f.ctx.on('session/event', (_session, event) => {
      if (event.type === 'job/settled' && event.data.jobId === id) settled.resolve(undefined)
    })
    done.resolve({ status: 'completed' })
    await settled.promise
    off()
    const child = await f.engine.admitChild({ maxActive: 1, ticket: { ticketId: 'busy-child' as T.ChildTicketId,
      parentSessionId: opened.sessionId, sequence: 0, requestDigest: 'busy-child' as T.SeatDigest,
      agentPreset: f.definition.agentPreset, permissionRevision: 1, phase: 'queued', childSessionId: null,
      ownerEpoch: 'busy-owner' as T.OwnerEpoch, stateVersion: 0 } })
    expect(child.status).toBe('admitted')
    const childBusy = await f.seats.renew({ sessionId: opened.sessionId, operationId: operation('child-renew') })
    expect(childBusy).toMatchObject({ status: 'rejected', error: { code: 'session-busy' } })
    if (childBusy.status !== 'rejected') throw new Error('Child renewal was admitted')
    expect(childBusy.error.message).toContain('busy-child')
    await f.engine.releaseChild('busy-child' as T.ChildTicketId)
  } finally { done.resolve({ status: 'killed' }); await f.close() }
})

it('projects all six runtime states from real question, approval and model lifecycles', async () => {
  const f = await admissionHost()
  const modelEntered = Promise.withResolvers<undefined>()
  const modelRelease = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const approval = Promise.withResolvers<ApprovalOutcome>()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('states') })
    if (opened.status !== 'prefilled') throw new Error('Window was not prefilled')
    const agent = f.ctx.agents.get(opened.sessionId)!
    const status = async (value: T.SeatWindowStatus) => {
      expect(await f.seats.list({})).toMatchObject({ sessions: [{ status: value }] })
    }
    await status('idle')
    f.ctx.on('user-questions/request', () => answer.promise)
    const questions = f.ctx.get('userQuestions')!
    const pending = questions.ask({ agent, questions: [{ id: 'answer', question: 'Continue?' }] })
    await status('answer-pending')
    const plan = questions.ask({ agent, questions: [{ id: 'plan', question: 'Approve?', detail: 'Plan details',
      options: [{ label: 'Approve' }], intent: { kind: 'plan-review', approve: 'Approve' } }] })
    await status('plan-review-pending')
    answer.resolve({ answers: [] })
    await Promise.all([pending, plan])
    const stream = f.adapter.stream.bind(f.adapter)
    vi.spyOn(f.adapter, 'stream').mockImplementation(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      modelEntered.resolve(undefined)
      await modelRelease.promise
      yield* stream(options)
    })
    expect(await f.ctx.get('seatReminderHost')!.send({ sessionId: opened.sessionId, id: 'six-states', kind: 'steer',
      content: 'Observe all runtime states.' })).toBe('accepted')
    await modelEntered.promise
    await status('running')
    f.ctx.on('approval/request', () => approval.promise)
    const decision = f.ctx.get('approval')!.request({ agent, toolName: 'test-operation' })
    await f.ctx.sessions.flush(agent.session)
    await status('approval-pending')
    approval.resolve('allowed-once')
    await decision
    modelRelease.resolve(undefined)
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    await status('completed')
    expect(JSON.stringify(f.adapter.requests)).toContain('Observe all runtime states.')
  } finally {
    answer.resolve({ answers: [] }); approval.resolve('cancelled'); modelRelease.resolve(undefined)
    await f.close()
  }
})

it('selects the latest committed binding and restores message windows without changing bindings', async () => {
  const f = await admissionHost()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('message-binding') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    const binding = await f.seats.binding({ sessionId: opened.sessionId })
    if (!binding || 'status' in binding || binding.kind !== 'seat') throw new Error('Seat binding is unavailable')
    const rebound = { ...binding, seat: 'rebound-seat' as T.SeatName }
    await f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'seat/binding',
      sessionId: opened.sessionId, data: rebound })] }))
    const windows = [{ seat: rebound.seat, sessionId: opened.sessionId, nodeId: binding.nodeId, primary: true }]
    expect(await f.seats.messageWindows!()).toEqual(windows)
    const restored = await f.reload()
    expect(await restored.messageWindows!()).toEqual(windows)
    await f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'seat/binding',
      sessionId: opened.sessionId, data: { kind: 'free', sessionId: opened.sessionId,
        nodeId: binding.nodeId, identitySource: 'free' } })] }))
    expect(await restored.messageWindows!()).toEqual([])
  } finally { await f.close() }
})

it('projects budget stop beside runtime state and restores it from the engine', async () => {
  const f = await admissionHost()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('budget-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    expect(await f.seats.list({})).toMatchObject({ sessions: [{ status: 'idle', engineStatus: 'prefilled' }] })
    await f.engine.configureBudget({ sessionId: opened.sessionId, limits: { windowBudgetUsd: '100' as T.MicroUsd },
      expectedRevision: 0, authorizationRef: 'budget-owner' as T.AuthorizationRef, operationId: operation('budget-limit') })
    await recordCost(f.ctx, opened.sessionId, 'budget-stop-cost', '0.0001')
    await f.engine.drive()
    expect(await f.seats.list({})).toMatchObject({ sessions: [{ status: 'idle', engineStatus: 'budget-stopped',
      canRenew: false, renewRejection: { code: 'budget-stopped' } }] })
    const restored = await f.reload()
    expect(await restored.list({})).toMatchObject({ sessions: [{ engineStatus: 'budget-stopped' }] })
    await f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/closing',
      sessionId: opened.sessionId, operationId: operation('closing'), data: { sessionId: opened.sessionId,
        operationId: operation('closing'), phase: 'admission', reason: 'manual', stateVersion: 1,
        endedAt: null, reportId: null, selfReport: null, selfReportStatus: 'not-submitted' } })] }))
    expect(await restored.list({})).toMatchObject({ sessions: [{ status: 'idle', engineStatus: 'closing', canRenew: false }] })
    expect(await restored.messageWindows!()).toEqual([])
  } finally { await f.close() }
})
