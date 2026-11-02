/** Original-key routes retain one durable send barrier across completed retries. */
import { afterEach, expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { queryOperation } from '../src/operation.ts'
import { CallbackOutbox } from '../src/outbox.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackIssuerPort, CallbackRouterPort } from '../src/routed-callback-types.ts'
import { SourceRegistry } from '../src/sources.ts'
import { harness, seat } from './fixtures.ts'
import { admittedDefinition, persistCallback, principalId } from './routed-callback-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers() })

test('folds one hundred real routed dispatch failures into one barrier and one closing frame', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine), sources = new SourceRegistry()
  cleanups.push(() => sources.close())
  let dispatches = 0
  const issuer: CallbackIssuerPort = { outboxIssuer: async () => h.engine.authorizationIssuers.register({ identity: {
    kind: 'human', principalId, nodeId: h.engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
  const router: CallbackRouterPort = { route: async (request) => {
    if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: { status: 'missing' } }
    dispatches++
    expect(request.operationId).toBe(body.route.originalOperationId)
    expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    return { method: 'source.deliverCallback', status: 'rejected', error: { code: 'unavailable',
      effectState: 'none', retryable: true } }
  } }
  h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
  const outbox = new CallbackOutbox(h.engine.journal, sources, { ...h.engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 }, (input, observation) => deliverRoutedCallback(h.ctx, h.engine, input, observation))
  cleanups.push(() => outbox.close())
  const before = h.engine.journal.projection.sequence
  for (let index = 0; index < 100; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  const query = { operationId: body.route.originalOperationId }
  expect(queryOperation(h.engine.journal.projection, query, 'Worker')).toMatchObject({ status: 'pending',
    progress: { blockedBy: ['callback-outcome-unknown'] } })
  expect(queryOperation(h.engine.journal.projection, query, 'Worker', outbox.observations()))
    .not.toMatchObject({ progress: { blockedBy: ['callback-outcome-unknown'] } })
  await outbox.close()
  expect(dispatches).toBe(100)
  expect(h.engine.journal.projection.sequence - before).toBe(2)
  const expected = { attempt: 100, retrySummary: { count: 100,
    firstAttemptAt: new Date(1000000).toISOString(), lastAttemptAt: new Date(1000099).toISOString() } }
  expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject(expected)
  await h.engine.journal.close()
  const recovered = await h.start()
  expect(recovered.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject(expected)
})

test('keeps failed query times when the original dispatch returns pending directly', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine), sources = new SourceRegistry()
  cleanups.push(() => sources.close())
  let connected = false
  const issuer: CallbackIssuerPort = { outboxIssuer: async () => h.engine.authorizationIssuers.register({ identity: {
    kind: 'human', principalId, nodeId: h.engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
  const router: CallbackRouterPort = { route: async (request) => {
    if (!connected) return { method: request.method, status: 'rejected', error: {
      code: 'unavailable', effectState: 'none', retryable: true } }
    if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: { status: 'missing' } }
    return { method: 'source.deliverCallback', status: 'ok', result: { status: 'pending',
      callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest, pendingReason: 'writeback-pending' } }
  } }
  h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
  const outbox = new CallbackOutbox(h.engine.journal, sources, { ...h.engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 },
  (input, observation) => deliverRoutedCallback(h.ctx, h.engine, input, observation))
  cleanups.push(() => outbox.close())
  for (let index = 0; index < 3; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  connected = true; vi.setSystemTime(1000010); await outbox.deliver()
  await outbox.close()
  const expected = { count: 4, lastAttemptAt: new Date(1000002).toISOString(),
    failures: { count: 3, firstAt: new Date(1000000).toISOString(), lastAt: new Date(1000002).toISOString() },
    directPending: { count: 1, firstAt: new Date(1000010).toISOString(), lastAt: new Date(1000010).toISOString() } }
  expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)?.retrySummary).toMatchObject(expected)
  await h.engine.journal.close()
  const recovered = await h.start()
  expect(recovered.journal.projection.callbacks.get(body.callback.callbackId)?.retrySummary).toMatchObject(expected)
})

test('accounts for transport folding, shutdown, send barrier and terminal delivery across restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const h = await harness(); cleanups.push(h.close)
  h.definitions.set(seat, admittedDefinition())
  const body = await persistCallback(h.engine), sources = new SourceRegistry()
  cleanups.push(() => sources.close())
  let engine = h.engine, connected = false, dispatches = 0
  const issuer: CallbackIssuerPort = { outboxIssuer: async () => engine.authorizationIssuers.register({ identity: {
    kind: 'human', principalId, nodeId: engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
  const router: CallbackRouterPort = { route: async (request) => {
    if (!connected) return { method: request.method, status: 'rejected', error: {
      code: 'unavailable', effectState: 'none', retryable: true } }
    if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: { status: 'missing' } }
    dispatches++
    expect(request.payload).toEqual(body)
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    return { method: 'source.deliverCallback', status: 'ok', result: { status: 'committed',
      callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } }
  } }
  h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
  const start = () => new CallbackOutbox(engine.journal, sources, { ...engine.options.config,
    callbackRetryInitialMs: 1, callbackRetryMaxMs: 1 },
  (input: T.DeliverSourceCallbackRequest, observation?: T.SeatCallbackDelivery) => deliverRoutedCallback(h.ctx, engine, input, observation))
  const frames = () => engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect =>
    (effect.kind === 'callback/attempted' || effect.kind === 'callback/delivered') && effect.data.payload.callbackId === body.callback.callbackId)
  let outbox = start(); cleanups.push(() => outbox.close())
  for (let index = 0; index < 100; index++) { vi.setSystemTime(1000000 + index); await outbox.deliver() }
  expect(frames()).toHaveLength(1)
  await outbox.close(); expect(frames()).toHaveLength(2)
  await engine.journal.close(); engine = await h.start()
  connected = true; vi.setSystemTime(1000100); outbox = start()
  await outbox.deliver(); await outbox.close()
  expect(frames()).toHaveLength(4)
  expect(dispatches).toBe(1)
  expect(engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject({ phase: 'delivered',
    retrySummary: { count: 100, attemptsAtLeast: true,
      firstAttemptAt: new Date(1000000).toISOString(), lastAttemptAt: new Date(1000099).toISOString() } })
})
