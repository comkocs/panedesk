/** Original-key routes retain one durable send barrier across completed retries. */
import { afterEach, expect, test, vi } from 'vitest'
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
