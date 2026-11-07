/** Link parking resumes only after a newer authenticated hello observation. */
import { afterEach, expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { callbackRetentions } from '../src/callback-retention.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import { SourceRegistry } from '../src/sources.ts'
import { fact } from '../src/triggers.ts'
import { harness, nodeId, seat } from './fixtures.ts'
import { admittedDefinition, owner, persistCallback } from './routed-callback-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
async function fixture(local = false) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition(local ? nodeId : owner))
  const body = await persistCallback(h.engine, local ? nodeId : owner)
  const sources = new SourceRegistry(); cleanups.push(() => sources.close())
  const current = () => h.engine.journal.projection.callbacks.get(body.callback.callbackId)!
  return { ...h, body, sources, current }
}
function transport(body: T.DeliverSourceCallbackRequest): T.SeatCallbackAttemptResult<T.DeliverSourceCallbackResult> {
  const cause: T.SeatFailureCause = { domain: 'node-link', code: 'node-tunnel-disconnected', reason: 'Transport disconnected',
    reasonCode: 'tunnel-disconnected', effectState: 'none', retryable: true, operationId: body.route.originalOperationId,
    nodeId: body.route.sourceOwnerNodeId }
  return { result: { status: 'rejected', error: { code: 'unavailable', message: 'Disconnected',
    alternative: 'Restore the link', effectState: 'none', retryable: true, cause } }, diagnostic: { stage: 'peer-query', cause } }
}

test('parks a disconnected chain then auto-resumes once on hello and delivers without an operator', async () => {
  const h = await fixture(); let ready = false, calls = 0
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, async (body) => {
    calls++
    return ready ? { result: { status: 'committed', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } } : transport(body)
  }, async () => ready)
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 1, lastDiagnostic: { cause: { code: 'callback-link-unreachable-limit' } } })
  const parked = h.engine.journal.projection.sequence
  for (let i = 0; i < 5; i++) await outbox.deliver()
  expect(h.engine.journal.projection.sequence).toBe(parked)
  expect(calls).toBe(1)
  ready = true; vi.setSystemTime(1900001); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'delivered', attempt: 2, nodeWorkChain: h.body })
  expect(h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/attempted'
    && effect.data.lastDiagnostic?.cause.code === 'callback-auto-resumed-on-link-ready')).toHaveLength(1)
  const delivered = h.engine.journal.projection.sequence
  await outbox.deliver(); await outbox.deliver()
  expect(h.engine.journal.projection.sequence).toBe(delivered)
})

test('does not auto-resume other-class parking when hello is ready', async () => {
  const h = await fixture(); let calls = 0
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, async () => {
    calls++; return { result: { status: 'rejected', error: { code: 'unavailable', message: 'Owner unavailable',
      alternative: 'Restore the owner', retryable: true, effectState: 'none' } } }
  }, async () => true)
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current().lastDiagnostic?.cause.code).toBe('callback-transient-limit-reached')
  const parked = h.engine.journal.projection.sequence
  await outbox.deliver(); await outbox.deliver()
  expect(h.engine.journal.projection.sequence).toBe(parked)
  expect(calls).toBe(1)
})

test('the engine reads cached hello readiness and leaves failed or repeated observations frame-free', async () => {
  const h = await fixture()
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.current(), attempt: 1,
    phase: 'paused', responseClass: 'transient', lastDiagnostic: { stage: 'retained', cause: {
      ...transport(h.body).diagnostic!.cause, code: 'callback-link-unreachable-limit', retryable: false } } } })])
  let ready = false, observedAt = 1000000
  const router = { route: vi.fn(), status: vi.fn(async () => [{ nodeId: owner, reachable: ready,
    linkState: ready ? 'connected' as const : 'disconnected' as const, capabilities: ready ? ['node-work-chain/v1'] : [],
    observedAt: new Date(observedAt).toISOString(), nodeName: 'owner', status: null, safeReason: null }]) }
  h.ctx.provide('nodeRouter', router)
  const callbackFrames = () => h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect =>
    effect.kind === 'callback/attempted' && effect.data.payload.callbackId === h.body.callback.callbackId).length
  const parked = callbackFrames()
  for (let i = 0; i < 3; i++) { await h.engine.drive(); await h.engine['outbox'].flush() }
  expect(callbackFrames()).toBe(parked)
  ready = true
  await h.engine.drive(); await h.engine['outbox'].flush()
  expect(callbackFrames()).toBe(parked)
  observedAt++; vi.setSystemTime(observedAt)
  await h.engine.drive(); await h.engine['outbox'].flush()
  expect(h.current().phase).toBe('retry-due')
  const resumed = () => h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/attempted'
    && effect.data.lastDiagnostic?.cause.code === 'callback-auto-resumed-on-link-ready')
  expect(resumed()).toHaveLength(1)
  await h.engine.drive(); await h.engine['outbox'].flush()
  expect(resumed()).toHaveLength(1)
  expect(router.route).not.toHaveBeenCalled()
})

test.each(['router', 'issuer'] as const)('missing %s hello readiness parks as a link failure', async (missing) => {
  const h = await fixture()
  if (missing === 'issuer') h.ctx.provide('nodeWorkChainRouter', { route: vi.fn(), recover: vi.fn() })
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config,
    body => deliverRoutedCallback(h.ctx, h.engine, body))
  cleanups.push(() => outbox.close())
  await outbox.deliver()
  expect(h.current().lastDiagnostic?.cause).toMatchObject({ domain: 'seat-callback', reasonCode: 'hello-policy-not-ready' })
  vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 1,
    lastDiagnostic: { cause: { code: 'callback-link-unreachable-limit' } } })
})

test('a second link parking requires a newer hello than its own parking frame', async () => {
  const h = await fixture()
  let observedAt = 1000000
  h.ctx.provide('nodeRouter', { route: vi.fn(), status: async () => [{ nodeId: owner, reachable: true,
    linkState: 'connected', capabilities: ['node-work-chain/v1'], observedAt: new Date(observedAt).toISOString(),
    nodeName: 'owner', status: null, safeReason: null }] })
  const drive = async () => { await h.engine.drive(); await h.engine['outbox'].flush() }
  const resumed = () => h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect =>
    effect.kind === 'callback/attempted' && effect.data.payload.callbackId === h.body.callback.callbackId
    && effect.data.lastDiagnostic?.cause.code === 'callback-auto-resumed-on-link-ready')
  await drive(); vi.setSystemTime(1900000); await drive()
  expect(h.current().lastDiagnostic?.cause.code).toBe('callback-link-unreachable-limit')
  observedAt = 1900001; vi.setSystemTime(observedAt); await drive()
  expect(resumed()).toHaveLength(1)
  vi.setSystemTime(2800001); await drive()
  expect(h.current().phase).toBe('paused')
  const before = h.engine.journal.projection.sequence
  await drive(); await drive()
  expect(resumed()).toHaveLength(1)
  expect(h.engine.journal.projection.sequence).toBe(before)
  observedAt = 2800002; vi.setSystemTime(observedAt); await drive()
  expect(resumed()).toHaveLength(2)
  expect(h.current().attempt).toBe(3)
  const after = h.engine.journal.projection.sequence
  await drive(); await drive()
  expect(resumed()).toHaveLength(2)
  expect(h.engine.journal.projection.sequence).toBe(after)
})

test('unincremented sending barriers do not reset a transient segment but final unknown does', async () => {
  const h = await fixture()
  const append = async (responseClass: T.SeatCallbackDelivery['responseClass'], attempt: number) => {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.current(), phase: 'retry-due', responseClass, attempt } })])
  }
  await append('transient', 1); vi.setSystemTime(1500000); await append('unknown', 1)
  expect(callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)?.since).toBe(1000000)
  await append('transient', 2)
  expect(callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)?.since).toBe(1000000)
  await append('unknown', 3)
  expect(callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)?.since).toBeUndefined()
  vi.setSystemTime(1600000); await append('transient', 4)
  expect(callbackRetentions(h.engine.journal.projection.decisions).get(h.body.callback.callbackId)?.since).toBe(1600000)
})

test('final unknown remains behind the original-key query barrier after the transient limit', async () => {
  const h = await fixture()
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.current(), phase: 'retry-due', attempt: 1,
    responseClass: 'unknown' } })])
  let calls = 0
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config,
    async (body) => { calls++; return transport(body) })
  cleanups.push(() => outbox.close())
  vi.setSystemTime(3000000); await outbox.deliver()
  expect(outbox.observations().find(item => item.payload.callbackId === h.body.callback.callbackId))
    .toMatchObject({ phase: 'retry-due', responseClass: 'unknown', attempt: 2 })
  expect(calls).toBe(1)
})

test('an absent local owner reaches the transient limit without link classification', async () => {
  const h = await fixture(true)
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config,
    body => deliverRoutedCallback(h.ctx, h.engine, body))
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 1,
    lastDiagnostic: { cause: { code: 'callback-transient-limit-reached' } } })
})

test.each([true, false])('automatic resume and operator abandon serialize with abandonFirst=%s', async (abandonFirst) => {
  const h = await fixture(); let ready = false
  const request: T.CallbackResolveRequest = { callbackId: h.body.callback.callbackId, action: 'abandon', expectedAttempt: 1 }
  let resolution: T.CallbackResolveResult | undefined
  const send = vi.fn(async (body: T.DeliverSourceCallbackRequest) => {
    if (ready && !abandonFirst) resolution = await h.engine.callbackResolve(request)
    return transport(body)
  })
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, send, async () => {
    if (ready && abandonFirst) resolution = await h.engine.callbackResolve(request)
    return ready
  })
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  const before = h.engine.journal.projection.sequence
  ready = true; vi.setSystemTime(1900001); await outbox.deliver()
  const transitions = h.engine.journal.projection.decisions.filter(frame => frame.sequence > before)
    .flatMap(frame => frame.effects).filter(effect => effect.kind === 'callback/attempted'
      && ['callback-auto-resumed-on-link-ready', 'callback-manually-abandoned'].includes(effect.data.lastDiagnostic?.cause.code ?? ''))
  expect(transitions).toHaveLength(1)
  expect(resolution).toMatchObject(abandonFirst ? { status: 'ok', phase: 'abandoned' }
    : { status: 'rejected', code: 'callback-not-paused' })
  expect(h.current().phase).toBe(abandonFirst ? 'abandoned' : 'retry-due')
  expect(send).toHaveBeenCalledTimes(abandonFirst ? 1 : 2)
})

test('a late owner committed receipt does not clear other-class seat parking', async () => {
  const h = await fixture(); let committed = false
  const send = vi.fn(async (body: T.DeliverSourceCallbackRequest): Promise<T.SeatCallbackAttemptResult<T.DeliverSourceCallbackResult>> => ({
    result: committed ? { status: 'committed', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest }
      : { status: 'rejected', error: { code: 'unavailable', message: 'Owner unavailable',
        alternative: 'Restore the owner', retryable: true, effectState: 'none' } },
  }))
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, send, async () => true)
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  const before = h.engine.journal.projection.sequence
  committed = true
  await outbox.deliver(); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', attempt: 1,
    lastDiagnostic: { cause: { code: 'callback-transient-limit-reached' } } })
  expect(h.engine.journal.projection.sequence).toBe(before)
  expect(send).toHaveBeenCalledTimes(1)
})

test('a local owner transient parks without becoming a link-class failure', async () => {
  const h = await fixture(true)
  const outbox = new CallbackOutbox(h.engine.journal, h.sources, h.engine.options.config, async body => transport(body))
  cleanups.push(() => outbox.close())
  await outbox.deliver(); vi.setSystemTime(1900000); await outbox.deliver()
  expect(h.current()).toMatchObject({ phase: 'paused', lastDiagnostic: { cause: { code: 'callback-transient-limit-reached' } } })
})
