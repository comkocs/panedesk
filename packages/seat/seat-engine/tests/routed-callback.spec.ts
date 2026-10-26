/** Sender exceptions reconcile immediately and unknown intents never blindly resend. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { rejected } from '../src/triggers.ts'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackChainRequest, CallbackIssuerPort, CallbackRouterPort } from '../src/routed-callback-types.ts'
import { harness, seat } from './fixtures.ts'
import { admittedDefinition, persistCallback, principalId } from './routed-callback-fixture.ts'

test('remote callbacks ignore the local owner and retain issuer refusals with their original cause', async () => {
  const h = await harness(), sources = new SourceRegistry()
  let outbox: CallbackOutbox | undefined
  try {
    h.definitions.set(seat, admittedDefinition())
    const body = await persistCallback(h.engine)
    const cause: T.SeatFailureCause = { domain: 'issuer', code: 'unauthorized', reason: 'Callback authority was revoked',
      effectState: 'none', retryable: false, operationId: body.route.originalOperationId, nodeId: body.callback.nodeId,
      reasonCode: 'evidence-revoked' }
    const refuse = { ...rejected('unauthorized', 'Callback authority was revoked'), error: {
      ...rejected('unauthorized', 'Callback authority was revoked').error, cause } }
    const local = vi.fn(async () => { throw new Error('Local owner must not be called') })
    h.ctx.provide('seatLocalCallbackOwner', { ready: async () => {}, available: () => true, query: local, deliver: local })
    const peer = vi.fn(async () => { throw new Error('Refused issuer must not reach peer') })
    h.ctx.provide('nodeWorkChainRouter', { route: peer })
    h.ctx.provide('nodeWorkChain', { outboxIssuer: async () => ({ check: async () => refuse }) })
    outbox = new CallbackOutbox(h.engine.journal, sources, h.engine.options.config, input => deliverRoutedCallback(h.ctx, h.engine, input))
    await outbox.deliver(0)
    expect(local).not.toHaveBeenCalled()
    expect(peer).not.toHaveBeenCalled()
    expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject({ phase: 'paused',
      responseClass: 'authentication', lastDiagnostic: { stage: 'issuer', cause } })
  } finally { await outbox?.close(); await sources.close(); await h.close() }
})

test('pauses a definite remote delivery authentication refusal with its original diagnostic', async () => {
  const h = await harness(), sources = new SourceRegistry()
  let outbox: CallbackOutbox | undefined
  try {
    h.definitions.set(seat, admittedDefinition())
    const body = await persistCallback(h.engine), seen: CallbackChainRequest[] = []
    const cause: T.SeatFailureCause = { domain: 'node-link', code: 'node-delegation-rejected',
      reason: 'Callback account is not authorized', effectState: 'none', retryable: false,
      operationId: body.route.originalOperationId, nodeId: body.route.sourceOwnerNodeId,
      reasonCode: 'method-not-allowed' }
    const issuer: CallbackIssuerPort = { outboxIssuer: async () => h.engine.authorizationIssuers.register({ identity: {
      kind: 'human', principalId, nodeId: h.engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
    const router: CallbackRouterPort = { route: async (request) => {
      seen.push(request)
      if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: { status: 'missing' } }
      return { method: 'source.deliverCallback', status: 'rejected', error: { code: 'unauthorized',
        retryable: false, effectState: 'none', cause } }
    } }
    h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
    outbox = new CallbackOutbox(h.engine.journal, sources, h.engine.options.config, input => deliverRoutedCallback(h.ctx, h.engine, input))
    await outbox.deliver(0)
    expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject({ phase: 'paused',
      responseClass: 'authentication', attempt: 1, nextDue: null,
      lastDiagnostic: { stage: 'peer-dispatch', cause } })
    expect(seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback'])
    await outbox.deliver(100)
    expect(seen).toHaveLength(2)
  } finally { await outbox?.close(); await sources.close(); await h.close() }
})

test.each(['pending', 'authentication', 'protocol', 'other'] as const)(
  'keeps the baseline class for an explicit remote owner %s result', async (kind) => {
    const h = await harness(), sources = new SourceRegistry()
    let outbox: CallbackOutbox | undefined
    try {
      h.definitions.set(seat, admittedDefinition())
      const body = await persistCallback(h.engine), seen: CallbackChainRequest[] = []
      let query: T.NodeWorkChainOperationResult = { status: 'missing' }
      const result: T.DeliverSourceCallbackResult = kind === 'pending' ? { status: 'pending',
        callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } : { status: 'rejected', error: {
        code: kind === 'authentication' ? 'unauthorized' : kind === 'protocol' ? 'callback-protocol-error' : 'unavailable',
        message: 'Owner refusal', alternative: 'Review owner state', retryable: false, effectState: 'none' } }
      const issuer: CallbackIssuerPort = { outboxIssuer: async () => h.engine.authorizationIssuers.register({ identity: {
        kind: 'human', principalId, nodeId: h.engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
      const router: CallbackRouterPort = { route: async (request) => {
        seen.push(request)
        return request.method === 'chain.operation' ? { method: request.method, status: 'ok', result: query }
          : { method: 'source.deliverCallback', status: 'ok', result }
      } }
      h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
      outbox = new CallbackOutbox(h.engine.journal, sources, h.engine.options.config,
        input => deliverRoutedCallback(h.ctx, h.engine, input))
      await outbox.deliver(0)
      const paused = kind === 'authentication' || kind === 'protocol'
      expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)).toMatchObject({
        phase: paused ? 'paused' : 'retry-due', responseClass: paused ? kind : 'transient', attempt: 1 })
      expect(seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback'])
      query = { status: 'pending', effectState: 'none' }
      await outbox.deliver(100)
      expect(seen.map(item => item.method)).toEqual(paused ? ['chain.operation', 'source.deliverCallback']
        : ['chain.operation', 'source.deliverCallback', 'chain.operation'])
      if (!paused) {
        expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('transient')
        query = { status: 'missing' }
        await outbox.deliver(200)
        expect(seen.map(item => item.method)).toEqual([
          'chain.operation', 'source.deliverCallback', 'chain.operation', 'chain.operation', 'source.deliverCallback',
        ])
      }
      for (const request of seen) {
        if (request.method === 'chain.operation') expect(request.payload).toMatchObject({
          key: { sourceNodeId: h.engine.options.nodeId, principalId, sourceId: body.route.sourceId,
            ownerEpoch: body.route.ownerEpoch, method: 'source.deliverCallback',
            operationId: body.route.originalOperationId, callbackId: body.callback.callbackId }, payloadDigest: body.payloadDigest })
        else expect(request.payload).toEqual(body)
      }
      expect(h.callbacks).toEqual([])
    } finally { await outbox?.close(); await sources.close(); await h.close() }
  })

test.each(['throw', 'timeout'] as const)('keeps an unknown callback unsent when its exact query fails by %s', async (mode) => {
  const h = await harness({ callbackTimeoutMs: 20 })
  const sources = new SourceRegistry()
  let outbox: CallbackOutbox | undefined
  try {
    h.definitions.set(seat, admittedDefinition())
    const body = await persistCallback(h.engine), seen: CallbackChainRequest[] = []
    let queriesFail = false
    const issuer: CallbackIssuerPort = { outboxIssuer: async () => h.engine.authorizationIssuers.register({ identity: {
      kind: 'human', principalId, nodeId: h.engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
    const router: CallbackRouterPort = { route: async (request) => {
      seen.push(request)
      if (request.method === 'chain.operation' && !queriesFail) return { method: request.method, status: 'ok', result: { status: 'missing' } }
      queriesFail = true
      if (mode === 'throw') throw new Error('Query unavailable')
      return new Promise<never>(() => {})
    } }
    h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
    outbox = new CallbackOutbox(h.engine.journal, sources, h.engine.options.config, input => deliverRoutedCallback(h.ctx, h.engine, input))
    await outbox.deliver(0)
    await outbox.deliver(100)
    expect(seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback', 'chain.operation', 'chain.operation'])
    expect(h.engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    for (const sent of seen) expect(sent.operationId).toBe(body.route.originalOperationId)
  } finally { await outbox?.close(); await sources.close(); await h.close() }
})

test.each(['throw', 'timeout'] as const)('queries during the same %s attempt and retains unknown across restart', async (mode) => {
  const h = await harness({ callbackTimeoutMs: 20 })
  const sources = new SourceRegistry()
  let outbox: CallbackOutbox | undefined
  try {
    h.definitions.set(seat, admittedDefinition())
    const body = await persistCallback(h.engine), seen: CallbackChainRequest[] = []
    let engine = h.engine, committed = false
    const issuer: CallbackIssuerPort = { outboxIssuer: async () => engine.authorizationIssuers.register({ identity: {
      kind: 'human', principalId, nodeId: engine.options.nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
    const router: CallbackRouterPort = { route: async (request) => {
      seen.push(request)
      if (request.method === 'chain.operation') return { method: request.method, status: 'ok', result: committed
        ? { status: 'settled', method: 'source.deliverCallback', result: { status: 'committed',
          callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } } : { status: 'missing' } }
      if (mode === 'throw') throw new Error('Transport response lost')
      return new Promise<never>(() => {})
    } }
    h.ctx.provide('nodeWorkChain', issuer); h.ctx.provide('nodeWorkChainRouter', router)
    outbox = new CallbackOutbox(engine.journal, sources, engine.options.config, input => deliverRoutedCallback(h.ctx, engine, input))
    await outbox.deliver(0)
    expect(seen.map(item => item.method)).toEqual(['chain.operation', 'source.deliverCallback', 'chain.operation'])
    const query = seen[2]
    expect(query?.method === 'chain.operation' && query.payload).toEqual({ payloadDigest: body.payloadDigest, key: {
      sourceNodeId: engine.options.nodeId, principalId, sourceId: body.route.sourceId, ownerEpoch: body.route.ownerEpoch,
      method: 'source.deliverCallback', operationId: body.route.originalOperationId, callbackId: body.callback.callbackId,
    } })
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    await outbox.close(); await engine.shutdown()
    engine = await h.start()
    outbox = new CallbackOutbox(engine.journal, sources, engine.options.config, input => deliverRoutedCallback(h.ctx, engine, input))
    await outbox.deliver(100)
    expect(seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
    expect(await engine.authorizations.operation({ operationId: body.route.originalOperationId })).toMatchObject({
      status: 'pending', progress: { blockedBy: ['callback-outcome-unknown'] },
    })
    committed = true
    await outbox.deliver(200)
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.phase).toBe('delivered')
    expect(seen.filter(item => item.method === 'source.deliverCallback')).toHaveLength(1)
  } finally { await outbox?.close(); await sources.close(); await h.close() }
})
