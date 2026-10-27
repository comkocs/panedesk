/** Callback retention measures committed transient segments, not process uptime. */
import { afterEach, expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { digest, EngineError, frame } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { config, harness, nodeId, seat, sourceId } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  const sources = new SourceRegistry(); cleanups.push(() => sources.close())
  const outbox = new CallbackOutbox(h.engine.journal, sources, config); cleanups.push(() => outbox.close())
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'bounded-callback' as T.CallbackId,
    sourceId, triggerId: 'bounded-trigger' as T.TriggerId, stateVersion: 1, seat, title: 'Retained callback',
    sessionId: 'bounded-session' as NonNullable<T.SeatCallbackPayload['sessionId']>, nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
  const initial: T.SeatCallbackDelivery = { payload, payloadDigest: digest(payload), attempt: 0,
    phase: 'pending', nextDue: null, responseClass: null }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: initial })])
  const current = () => h.engine.journal.projection.callbacks.get(payload.callbackId)!
  return { ...h, sources, outbox, payload, initial, current }
}
function failing(sources: SourceRegistry, callback: T.SeatTriggerSource['callback'] = async () => { throw new Error('PRIVATE_SENTINEL') }) {
  return sources.register({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback })
}

test('C11-a exposes a fixed unclassified diagnostic through query without exception text', async () => {
  const h = await fixture(); failing(h.sources)
  await h.outbox.deliver()
  expect(h.current().lastDiagnostic).toMatchObject({ stage: 'local-dispatch', cause: {
    code: 'callback-unclassified-error', effectState: 'unknown', operationId: `callback/${digest(h.payload.callbackId)}` } })
  const page = await h.engine.query({ limit: 100, kinds: ['callback/attempted'] })
  expect(JSON.stringify(page)).toContain('callback-unclassified-error')
  expect(JSON.stringify(h.engine.journal.projection.authorizationDecisions)).not.toContain('PRIVATE_SENTINEL')
})

test('C11-b parks at 900000 but not 899999 and appends nothing after restart', async () => {
  const h = await fixture(); const call = vi.fn(async () => { throw new Error('failure') }); failing(h.sources, call)
  await h.outbox.deliver()
  vi.setSystemTime(1899999); await h.outbox.deliver()
  expect(h.current().phase).toBe('retry-due')
  vi.setSystemTime(1900000); await h.outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 2, nextDue: null,
    lastDiagnostic: { stage: 'retained', cause: { code: 'callback-transient-limit-reached', retryable: false } } })
  const count = h.engine.journal.projection.sequence
  for (let i = 0; i < 3; i++) await h.outbox.deliver()
  await h.engine.shutdown()
  const restarted = await h.start()
  await restarted.drive(); await restarted.drive()
  expect(restarted.journal.projection.sequence).toBe(count)
  expect(call).toHaveBeenCalledTimes(2)
})

test('C11-c delivers within the window and clears only the latest diagnostic', async () => {
  const h = await fixture(); let fail = true
  failing(h.sources, async () => { if (fail) throw new Error('failure') })
  await h.outbox.deliver(); fail = false
  vi.setSystemTime(1899999); await h.outbox.deliver()
  expect(h.current()).toEqual({ ...h.initial, phase: 'delivered', attempt: 2, responseClass: 'success' })
  expect(JSON.stringify(h.engine.journal.projection.decisions)).toContain('callback-unclassified-error')
})

test.each(['callback-authentication-failed', 'callback-protocol-error'] as const)('keeps immediate %s parking', async (code) => {
  const h = await fixture(); failing(h.sources, async () => { throw new EngineError(code, 'PRIVATE_SENTINEL') })
  await h.outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', lastDiagnostic: { cause: { code } } })
  expect(JSON.stringify(h.engine.journal.projection.decisions)).not.toContain('PRIVATE_SENTINEL')
})

test('records a fixed timeout with unknown effects after an adapter settles', async () => {
  const h = await fixture()
  failing(h.sources, async () => { vi.advanceTimersByTime(config.callbackTimeoutMs + 1) })
  await h.outbox.deliver()
  expect(h.current()).toMatchObject({ responseClass: 'transient', lastDiagnostic: {
    stage: 'local-dispatch', cause: { code: 'callback-timeout', effectState: 'unknown' } } })
})

test('correlates callbacks without a session using a stable callback digest', async () => {
  const h = await fixture(); failing(h.sources)
  const payload: T.SeatCallbackPayload = { ...h.payload, kind: 'rejected', sessionId: null, title: null,
    reason: { code: 'gate-denied', message: 'Denied', alternative: 'Review', retryable: false, effectState: 'none' } }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { ...h.initial, payload, payloadDigest: digest(payload) } })])
  await h.outbox.deliver()
  expect(h.current().lastDiagnostic?.cause.operationId).toBe(`callback/${digest(payload.callbackId)}`)
})

test('retains the first committed transient across restart and a changed failure code', async () => {
  const h = await fixture(); failing(h.sources)
  await h.outbox.deliver()
  await h.engine.shutdown(); const restarted = await h.start()
  const sources = new SourceRegistry(); cleanups.push(() => sources.close())
  failing(sources, async () => { vi.advanceTimersByTime(config.callbackTimeoutMs + 1) })
  const outbox = new CallbackOutbox(restarted.journal, sources, config); cleanups.push(() => outbox.close())
  vi.setSystemTime(1500000); await outbox.deliver()
  vi.setSystemTime(1900000); await outbox.deliver()
  expect(restarted.journal.projection.callbacks.get(h.payload.callbackId)?.phase).toBe('paused')
})

test.each([true, false])('uses completion time across the limit with success=%s', async (success) => {
  const h = await fixture(); let first = true
  failing(h.sources, async () => {
    if (first) { first = false; throw new Error('initial') }
    vi.setSystemTime(1900001)
    if (!success) throw new Error('late failure')
  })
  await h.outbox.deliver(); vi.setSystemTime(1899999)
  const before = h.engine.journal.projection.sequence
  await h.outbox.deliver()
  expect(h.current()).toMatchObject({ phase: success ? 'delivered' : 'paused', attempt: 2 })
  expect(h.engine.journal.projection.sequence).toBe(before + 1)
  expect(h.engine.journal.projection.decisions.at(-1)?.effects).toHaveLength(1)
})

test('parks before nextDue and without an available source', async () => {
  const h = await fixture()
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.initial,
    phase: 'retry-due', attempt: 1, responseClass: 'transient', nextDue: new Date(9000000).toISOString() } })])
  const before = h.engine.journal.projection.sequence
  vi.setSystemTime(1900000); await h.outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 1 })
  expect(h.engine.journal.projection.sequence).toBe(before + 1)
  expect(h.engine.journal.projection.decisions.at(-1)?.effects).toHaveLength(1)
})

test('a failed parking append never publishes paused', async () => {
  const h = await fixture(); failing(h.sources)
  await h.outbox.deliver(); vi.setSystemTime(1900000)
  const commit = vi.spyOn(h.engine.journal, 'commit').mockRejectedValueOnce(new Error('write failed'))
  await expect(h.outbox.deliver()).rejects.toThrow('write failed')
  commit.mockRestore()
  expect(h.current().phase).toBe('retry-due')
})

test('a delivered result committed before parking wins the submission recheck', async () => {
  const h = await fixture(); failing(h.sources)
  await h.outbox.deliver(); vi.setSystemTime(1900000)
  const commit = h.engine.journal.commit.bind(h.engine.journal)
  const spy = vi.spyOn(h.engine.journal, 'commit').mockImplementationOnce(async (build, revision, metadata) => {
    await commit(() => [fact({ kind: 'callback/delivered', data: { ...h.current(), phase: 'delivered', responseClass: 'success', nextDue: null } })])
    return commit(build, revision, metadata)
  })
  await h.outbox.deliver(); spy.mockRestore()
  expect(h.current().phase).toBe('delivered')
})

test('a first successful callback retains the baseline delivery fields', async () => {
  const h = await fixture(); failing(h.sources, async () => {})
  await h.outbox.deliver()
  expect(h.current()).toEqual({ ...h.initial, phase: 'delivered', attempt: 1, responseClass: 'success' })
})

test('task and seat diagnostic pages retain failure history through complete', async () => {
  const h = await fixture(); let failed = true
  const taskId = 'callback-task' as T.SeatTaskId
  const payload = { ...h.payload, taskId, relatedTaskIds: [taskId] }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { ...h.initial, payload,
    payloadDigest: digest(payload) } })])
  failing(h.sources, async () => { if (failed) throw new Error('PRIVATE_SENTINEL') })
  await h.outbox.deliver(); failed = false
  vi.setSystemTime(1000100); await h.outbox.deliver()
  const effects: T.EngineEffect[] = []
  let cursor: T.EngineCursor | undefined, pages = 0
  do {
    const page = await h.ctx.get('seatAuthorizationQueries')!.tasks({ taskId, seat, limit: 1,
      kinds: ['callback/pending', 'callback/attempted', 'callback/delivered'], ...(cursor ? { cursor } : {}) })
    if ('status' in page) throw new Error('Expected callback page')
    effects.push(...page.effects); pages++
    if (page.complete) break
    expect(page.nextCursor).toBeDefined()
    expect(page.nextCursor).not.toEqual(cursor)
    cursor = page.nextCursor
  } while (pages < 10)
  expect(pages).toBe(3)
  expect(effects.map(effect => effect.kind)).toEqual(['callback/pending', 'callback/attempted', 'callback/delivered'])
  expect(JSON.stringify(effects)).toContain('callback-unclassified-error')
  expect(JSON.stringify(effects)).not.toContain('PRIVATE_SENTINEL')
  expect(h.current().lastDiagnostic).toBeUndefined()
})

test('parking blocks its ended callback but another group continues', async () => {
  const h = await fixture(); const sent: T.CallbackId[] = []
  failing(h.sources, async (payload) => { sent.push(payload.callbackId) })
  const ended: T.SeatCallbackPayload = { ...h.payload, kind: 'window-ended', callbackId: 'blocked-ended' as T.CallbackId,
    stateVersion: 2, reason: 'manual', endedAt: new Date().toISOString(), selfReport: null, selfReportStatus: 'not-submitted' }
  const other: T.SeatCallbackPayload = { ...h.payload, callbackId: 'another-group' as T.CallbackId,
    triggerId: 'another-trigger' as T.TriggerId }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.initial,
    phase: 'paused', attempt: 1, responseClass: 'transient' } }), ...[ended, other].map(payload => fact({
    kind: 'callback/pending', data: { ...h.initial, payload, payloadDigest: digest(payload) } }))])
  await h.outbox.deliver()
  expect(sent).toEqual([other.callbackId])
  expect(h.engine.journal.projection.callbacks.get(ended.callbackId)?.attempt).toBe(0)
  expect(h.current().phase).toBe('paused')
})

test('a sanitized 20476-attempt legacy callback parks on the first drive with zero I/O', async () => {
  const h = await fixture(); const call = vi.fn(async () => {}); failing(h.sources, call)
  for (let attempt = 1; attempt <= 20476; attempt++) {
    const data: T.SeatCallbackDelivery = { ...h.initial, attempt, phase: 'retry-due', responseClass: 'transient', nextDue: null }
    h.engine.journal.projection.apply(frame({ namespace: 'ledger/engine/v1', schemaVersion: 1,
      decisionId: `legacy-${attempt}` as T.EngineDecisionId, nodeId, sequence: attempt + 1,
      observedAt: new Date(1000000 + attempt - 1).toISOString(), policyRevision: 0,
      effects: [fact({ kind: 'callback/attempted', data })] }))
  }
  vi.setSystemTime(1900000); await h.outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 20476 })
  expect(call).not.toHaveBeenCalled()
})
