import { afterEach, expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, seat, trigger } from './fixtures.ts'
import { commitsEffect } from '../../seat/tests/completion.ts'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { digest } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { admittedDefinition, persistCallback } from './routed-callback-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function deliverRetry(h: Awaited<ReturnType<typeof harness>>, callbackId: T.SeatCallbackPayload['callbackId']) {
  const delivery = h.engine.journal.projection.callbacks.get(callbackId)!
  expect(delivery.phase).toBe('retry-due')
  if (delivery.nextDue === null) throw new Error('Missing callback retry deadline')
  vi.setSystemTime(Date.parse(delivery.nextDue))
  await commitsEffect(h.ctx, effect => effect.kind === 'callback/delivered'
    && effect.data.payload.callbackId === callbackId, () => h.engine.drive())
  expect(h.engine.journal.projection.callbacks.get(callbackId)?.phase).toBe('delivered')
}
it('blocks window-ended while opened for the same source session and trigger is unconfirmed', async () => {
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition())
  const opened = await persistCallback(h.engine)
  const payload: T.SeatCallbackPayload = { ...opened.callback, kind: 'window-ended', callbackId: 'ended-a' as T.CallbackId,
    stateVersion: 2, reason: 'manual', endedAt: '2026-01-01T00:00:00Z', selfReport: null, selfReportStatus: 'not-submitted' }
  const body = { callback: payload, route: opened.route, modelEvidence: opened.modelEvidence }
  const ended: T.DeliverSourceCallbackRequest = { ...body, payloadDigest: digest(body) }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { payload, payloadDigest: digest(payload),
    attempt: 0, phase: 'pending', nextDue: null, responseClass: null, nodeWorkChain: ended } })])
  let committed = false
  const seen: T.DeliverSourceCallbackRequest[] = []
  const sources = new SourceRegistry()
  const outbox = new CallbackOutbox(h.engine.journal, sources, h.engine.options.config, async (request) => {
    seen.push(request)
    return { result: { status: committed ? 'committed' : 'pending', callbackId: request.callback.callbackId, payloadDigest: request.payloadDigest } }
  })
  try {
    await outbox.deliver(0)
    expect(seen).toEqual([opened])
    expect(h.engine.journal.projection.callbacks.get(payload.callbackId)?.attempt).toBe(0)
    committed = true
    await outbox.deliver(100)
    expect(seen).toEqual([opened, opened, ended])
    expect([...h.engine.journal.projection.callbacks.values()].every(delivery => delivery.phase === 'delivered')).toBe(true)
  } finally { await outbox.close(); await sources.close() }
})

it('A10 publishes complete opened payload before first-turn completion and retries the same callback', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  h.state.opening = 'pending'; h.state.callbackFailures = 1
  await h.engine.accept({ ...trigger('external', 'event-a'), taskId: 'task-a' as T.SeatTaskId })
  await h.engine.accept({ ...trigger('external', 'event-b'), taskId: 'task-b' as T.SeatTaskId })
  await commitsEffect(h.ctx, effect => effect.kind === 'callback/attempted'
    && effect.data.phase === 'retry-due', () => h.engine.drive())
  const first = h.callbacks[0]!
  expect(first).toEqual({ kind: 'opened', seat, sessionId: h.creates[0], nodeId: 'node-a', nodeName: 'node-a',
    budget: {}, taskId: 'task-a', relatedTaskIds: ['task-a', 'task-b'], title: first.title,
    callbackId: first.callbackId, sourceId: 'source-a', triggerId: 'event-a', stateVersion: first.stateVersion })
  expect(first.stateVersion).toBeTypeOf('number')
  expect(first.title).toMatch(/^seat-a \d\d-\d\d$/)
  expect(first.callbackId).toBeTruthy()
  expect(h.engine.journal.projection.opens.get(h.creates[0]!)?.phase).toBe('opening-pending')
  expect([...h.engine.journal.projection.callbacks.values()].some(item => item.phase === 'retry-due')).toBe(true)
  await deliverRetry(h, first.callbackId)
  expect([...h.engine.journal.projection.callbacks.values()].every(item => item.phase === 'delivered')).toBe(true)
  const retries = h.callbacks.filter(payload => payload.triggerId === first.triggerId)
  expect(retries).toHaveLength(2); expect(retries[1]).toEqual(first)
  expect(new Set(h.callbacks.map(payload => payload.callbackId)).size).toBe(2)
  expect(h.engine.journal.projection.opens.get(h.creates[0]!)?.binding).toMatchObject({ taskId: 'task-a', relatedTaskIds: ['task-a', 'task-b'] })
})
it('A10 preserves ended reason and all report fields after an earlier failed callback', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  h.state.callbackFailures = 1
  await h.engine.accept(trigger())
  await commitsEffect(h.ctx, effect => effect.kind === 'callback/attempted'
    && effect.data.phase === 'retry-due', () => h.engine.drive())
  const opened = h.callbacks[0]!
  const report: T.CloseSelfReport = { reportId: 'report-a' as T.CloseReportId, sessionId: h.creates[0]!, canClose: true,
    waitingFor: [], nextOpen: { when: { kind: 'condition', description: 'After review' }, prerequisites: [] }, stateVersion: 1, submittedAt: new Date().toISOString() }
  const endedAt = new Date().toISOString()
  await h.engine.recordClosed({ sessionId: h.creates[0]!, phase: 'closed', reason: 'manual',
    stateVersion: 2, endedAt, selfReport: report, selfReportStatus: 'submitted', reportId: report.reportId })
  expect(h.engine.journal.projection.resources.has(h.creates[0]!)).toBe(false)
  const closeFrame = h.engine.journal.projection.decisions.at(-1)!
  expect(closeFrame.effects.map(effect => effect.kind)).toEqual(['window/closed', 'resource/released', 'callback/pending'])
  expect([...h.engine.journal.projection.callbacks.values()].some(item => item.phase === 'retry-due')).toBe(true)
  await commitsEffect(h.ctx, effect => effect.kind === 'callback/delivered'
    && effect.data.payload.kind === 'window-ended', () => deliverRetry(h, opened.callbackId))
  expect(h.callbacks.map(payload => payload.kind)).toEqual(['opened', 'opened', 'window-ended'])
  const ended = h.callbacks.at(-1)!
  expect(ended.callbackId).toBeTypeOf('string')
  expect(ended.callbackId).not.toBe(opened.callbackId)
  expect(ended).toEqual({ ...opened, kind: 'window-ended', callbackId: ended.callbackId,
    stateVersion: closeFrame.sequence, reason: 'manual', endedAt, selfReport: report,
    selfReportStatus: 'submitted', reportId: report.reportId })
})
