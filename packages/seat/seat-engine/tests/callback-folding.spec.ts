/** Retry summaries retain exact completed attempts without one frame per retry. */
import { afterEach, expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { callbackRetentions } from '../src/callback-retention.ts'
import { SourceRegistry } from '../src/sources.ts'
import { harness, seat } from './fixtures.ts'
import { admittedDefinition, persistCallback } from './routed-callback-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers() })
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine)
  const sources = new SourceRegistry(); cleanups.push(() => sources.close())
  const current = () => h.engine.journal.projection.callbacks.get(body.callback.callbackId)!
  return { ...h, sources, body, current }
}
function unavailable(): T.SeatCallbackAttemptResult<T.DeliverSourceCallbackResult> {
  return { result: { status: 'rejected', error: { code: 'unavailable', message: 'Transport unavailable',
    alternative: 'Retry the original callback', retryable: true, effectState: 'none' } } }
}

test('folds one hundred failed attempts into two frames on normal close and reconstructs their times', async () => {
  const h = await fixture()
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, { ...h.engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 }, async () => unavailable())
  const before = h.engine.journal.projection.sequence
  for (let index = 0; index < 100; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  await outbox.close()
  expect(h.engine.journal.projection.sequence - before).toBeLessThanOrEqual(2)
  expect(h.current()).toMatchObject({ attempt: 100, retrySummary: { count: 100,
    firstAttemptAt: new Date(1000000).toISOString(), lastAttemptAt: new Date(1000099).toISOString() } })
  const retained = callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)
  expect(retained).toMatchObject({ attempt: 100, since: 1000000, attemptsAtLeast: true })
})

test('reopens an interrupted retry from its durable lower bound without inventing lost attempts', async () => {
  const h = await fixture()
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, { ...h.engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 }, async () => unavailable())
  for (let index = 0; index < 100; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  expect(h.current().retrySummary?.attemptsAtLeast).toBeUndefined()
  // Closing only the journal discards the separately owned outbox buffer, like an interrupted process.
  await h.engine.journal.close()
  const recovered = await h.start()
  expect(recovered.journal.projection.callbacks.get(h.body.callback.callbackId)).toMatchObject({ attempt: 1,
    retrySummary: { count: 1, attemptsAtLeast: true, firstAttemptAt: new Date(1000000).toISOString() } })
})

test('folds retries into the delivery frame and retains the latest safe failure', async () => {
  const h = await fixture(); let committed = false
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, { ...h.engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 }, async () => committed
    ? { result: { status: 'committed', callbackId: h.body.callback.callbackId, payloadDigest: h.body.payloadDigest } }
    : unavailable())
  cleanups.push(() => outbox.close())
  const before = h.engine.journal.projection.sequence
  for (let index = 0; index < 100; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  committed = true; vi.setSystemTime(1000100); await outbox.deliver()
  expect(h.engine.journal.projection.sequence - before).toBe(2)
  expect(h.current()).toMatchObject({ phase: 'delivered', attempt: 101,
    retrySummary: { count: 100, lastDiagnostic: { cause: { code: 'unavailable' } } } })
})

test('pending owner observations reset the transient segment and never become transport parking', async () => {
  const h = await fixture(); let pending = false
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, async () => pending
    ? { result: { status: 'pending', callbackId: h.body.callback.callbackId, payloadDigest: h.body.payloadDigest } }
    : unavailable())
  cleanups.push(() => outbox.close())
  await outbox.deliver(); pending = true; vi.setSystemTime(1500000); await outbox.deliver()
  vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current().phase).toBe('retry-due')
  await outbox.close()
  expect(callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)?.since).toBeUndefined()
})

test.each(['callback-owner-unconfirmed-limit', 'callback-desk-unreachable'] as const)(
  'preserves owner parking category %s without using worker link readiness', async (code) => {
    const h = await fixture(); const ready = vi.fn(async () => true)
    const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, async () => ({ result: {
      status: 'paused', callbackId: h.body.callback.callbackId, payloadDigest: h.body.payloadDigest,
      error: { code: 'unavailable', message: code, alternative: 'Restore the source owner', retryable: false,
        effectState: 'unknown', cause: { domain: 'desk', code, reason: code, retryable: false, effectState: 'unknown',
          operationId: h.body.route.originalOperationId, nodeId: h.body.route.sourceOwnerNodeId } },
    } }), ready)
    cleanups.push(() => outbox.close())
    await outbox.deliver(); await outbox.deliver()
    expect(h.current()).toMatchObject({ phase: 'paused', parkingClass: 'owner-unconfirmed', lastDiagnostic: { cause: { code } } })
    expect(ready).not.toHaveBeenCalled()
  })
