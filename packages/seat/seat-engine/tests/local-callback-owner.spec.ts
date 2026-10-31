/** Frozen same-node callbacks consume only the optional owner and retain uncertainty durably. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import { callbackFailure } from '../src/routed-callback-types.ts'
import { digest } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { harness, seat, nodeId } from './fixtures.ts'
import { admittedDefinition, persistCallback, principalId } from './routed-callback-fixture.ts'

async function local() {
  const h = await harness({ callbackTimeoutMs: 20 })
  h.definitions.set(seat, admittedDefinition(nodeId))
  const body = await persistCallback(h.engine, nodeId)
  const sources = new SourceRegistry()
  let engine = h.engine
  const outbox = new CallbackOutbox(engine.journal, sources, engine.options.config,
    (request, observation) => deliverRoutedCallback(h.ctx, engine, request, observation))
  return { h, body, sources, outbox, engine: () => engine,
    restart: async () => { await outbox.close(); await engine.shutdown(); engine = await h.start()
      return new CallbackOutbox(engine.journal, sources, engine.options.config, (request, observation) => deliverRoutedCallback(h.ctx, engine, request, observation)) },
    close: async () => { await outbox.close(); await sources.close(); await h.close() } }
}
function owner(body: T.DeliverSourceCallbackRequest): T.SeatLocalCallbackOwner {
  return { ready: async () => {}, available: () => true,
    query: async () => ({ result: { status: 'missing' } }),
    deliver: async () => ({ result: { status: 'committed', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } }) }
}

test('calls only the optional owner seam when the frozen callback owner is local', async () => {
  const f = await local()
  try {
    const provider = owner(f.body), query = vi.spyOn(provider, 'query'), send = vi.spyOn(provider, 'deliver')
    const peer = vi.fn(async () => { throw new Error('Peer must not be called') })
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    f.h.ctx.provide('nodeWorkChainRouter', { route: peer })
    await f.outbox.deliver(0)
    expect(peer).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledExactlyOnceWith({ key: { sourceNodeId: nodeId, principalId,
      sourceId: f.body.route.sourceId, ownerEpoch: f.body.route.ownerEpoch, method: 'source.deliverCallback',
      operationId: f.body.route.originalOperationId, callbackId: f.body.callback.callbackId }, payloadDigest: f.body.payloadDigest })
    expect(send).toHaveBeenCalledExactlyOnceWith(f.body, query.mock.calls[0]![0].key)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.phase).toBe('delivered')
    expect(f.h.callbacks).toEqual([])
  } finally { await f.close() }
})

test('missing local provider never falls back to source.callback and records a safe cause', async () => {
  const f = await local()
  try {
    const before = structuredClone(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)!)
    await f.outbox.deliver(0)
    const after = f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)!
    expect(after).toMatchObject({ phase: 'retry-due', responseClass: 'transient', attempt: 1,
      lastDiagnostic: { stage: 'local-query', cause: { code: 'unavailable', effectState: 'none',
        reasonCode: 'hello-policy-not-ready', reason: 'Local callback owner is unavailable' } } })
    expect(after.payloadDigest).toBe(before.payloadDigest)
    expect(after.nodeWorkChain).toEqual(before.nodeWorkChain)
    expect(f.h.callbacks).toEqual([])
    expect(after.nextDue).not.toBeNull()
  } finally { await f.close() }
})

test('delivers only after exact local missing and never repeats pending business delivery', async () => {
  const f = await local()
  try {
    let state: 'pending' | 'missing' | 'committed' = 'pending'
    const provider = owner(f.body)
    provider.query = async () => ({ result: state === 'committed' ? { status: 'settled', method: 'source.deliverCallback',
      result: { status: 'committed', callbackId: f.body.callback.callbackId, payloadDigest: f.body.payloadDigest } }
      : state === 'missing' ? { status: 'missing' } : { status: 'pending', effectState: 'none' } })
    const send = vi.fn(async (): ReturnType<T.SeatLocalCallbackOwner['deliver']> => {
      expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.responseClass).toBe('unknown')
      state = 'pending'
      return { result: { status: 'pending', callbackId: f.body.callback.callbackId, payloadDigest: f.body.payloadDigest } }
    })
    provider.deliver = send
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(send).not.toHaveBeenCalled()
    state = 'missing'
    await f.outbox.deliver(100)
    await f.outbox.deliver(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.responseClass).toBe('unknown')
    state = 'committed'
    await f.outbox.deliver(400)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.phase).toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

test.each(['method', 'callbackId', 'digest'] as const)('rejects a settled local callback with a mismatched %s', async (field) => {
  const f = await local()
  try {
    const provider = owner(f.body), send = vi.spyOn(provider, 'deliver')
    provider.query = async () => ({ result: field === 'method' ? { status: 'settled', method: 'source.checkAdmission',
      result: { status: 'allowed', policyRevision: 1 } } : { status: 'settled', method: 'source.deliverCallback',
      result: { status: 'committed', callbackId: field === 'callbackId' ? 'other' as T.CallbackId : f.body.callback.callbackId,
        payloadDigest: field === 'digest' ? digest('other') : f.body.payloadDigest } } })
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(send).not.toHaveBeenCalled()
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.phase).toBe('paused')
  } finally { await f.close() }
})

test.each(['throw', 'timeout'] as const)('unknown delivery survives %s restart revocation and failed queries without becoming resendable', async (mode) => {
  const f = await local()
  let restarted: CallbackOutbox | undefined
  try {
    const provider = owner(f.body)
    let queried: T.NodeWorkChainOperationResult = { status: 'missing' }, available = true, failRead = false
    provider.available = () => available
    provider.query = async () => { if (failRead) throw new Error('Synthetic private exception'); return { result: queried } }
    const send = vi.fn(async (): ReturnType<T.SeatLocalCallbackOwner['deliver']> => {
      if (mode === 'throw') throw new Error('Synthetic private exception')
      return new Promise<never>(() => {})
    })
    provider.deliver = send
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    restarted = await f.restart()
    for (const result of [{ status: 'missing' }, { status: 'pending', effectState: 'none' },
      { status: 'pending', effectState: 'unknown' }, { status: 'settled', method: 'source.checkAdmission',
        result: { status: 'allowed', policyRevision: 1 } }] satisfies T.NodeWorkChainOperationResult[]) {
      queried = result
      await restarted.deliver(Date.now() + 10000)
      expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.responseClass).toBe('unknown')
    }
    available = false
    await restarted.deliver(Date.now() + 20000)
    available = true; failRead = true
    await restarted.deliver(Date.now() + 30000)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.responseClass).toBe('unknown')
    expect(JSON.stringify(f.engine().journal.projection.decisions)).not.toContain('Synthetic private exception')
    failRead = false
    queried = { status: 'settled', method: 'source.deliverCallback', result: {
      status: 'committed', callbackId: f.body.callback.callbackId, payloadDigest: f.body.payloadDigest } }
    await restarted.deliver(Date.now() + 40000)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.phase).toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
  } finally { await restarted?.close(); await f.close() }
})

test('pauses operation-id-conflict instead of retrying it as transient', async () => {
  const f = await local()
  try {
    const provider = owner(f.body)
    provider.query = async () => callbackFailure(f.body, 'owner-inbox', 'Callback identity conflicts',
      'operation-id-conflict', 'none', 'operation-payload-conflict')
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)).toMatchObject({
      phase: 'paused', responseClass: 'protocol', lastDiagnostic: { stage: 'owner-inbox', cause: { code: 'operation-id-conflict' } } })
  } finally { await f.close() }
})

test('persists safe diagnostics with attempted and restores old records without the optional field', async () => {
  const f = await local()
  let restarted: CallbackOutbox | undefined
  try {
    const first = f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)!
    expect(Object.hasOwn(first, 'lastDiagnostic')).toBe(false)
    await f.outbox.deliver(0)
    const failureFrame = f.engine().journal.projection.decisions.at(-1)!
    expect(failureFrame.effects).toHaveLength(1)
    expect(failureFrame.effects[0]).toMatchObject({ kind: 'callback/attempted', data: { lastDiagnostic: { stage: 'local-query' } } })
    restarted = await f.restart()
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.lastDiagnostic).toBeDefined()
    f.h.ctx.provide('seatLocalCallbackOwner', owner(f.body))
    await restarted.deliver(100)
    const final = f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)!
    expect(final.phase).toBe('delivered')
    expect(Object.hasOwn(final, 'lastDiagnostic')).toBe(false)
    expect(final.payloadDigest).toBe(first.payloadDigest)
    expect(final.nodeWorkChain).toEqual(first.nodeWorkChain)
    expect(failureFrame.effects[0]).toMatchObject({ data: { lastDiagnostic: { stage: 'local-query' } } })
  } finally { await restarted?.close(); await f.close() }
})

test('invalid provider diagnostics use a fixed refusal without persisting dynamic secret text', async () => {
  const f = await local()
  try {
    const provider = owner(f.body)
    provider.query = async () => ({ result: { status: 'pending', effectState: 'unknown' }, diagnostic: {
      stage: 'local-query', cause: { domain: 'invalid domain', code: 'unavailable', reason: 'Synthetic private diagnostic',
        effectState: 'unknown', retryable: false, operationId: f.body.route.originalOperationId, nodeId } } })
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)).toMatchObject({ responseClass: 'unknown',
      lastDiagnostic: { cause: { reasonCode: 'invalid-diagnostic', reason: 'Callback diagnostic was invalid' } } })
    expect(JSON.stringify(f.engine().journal.projection.decisions)).not.toContain('Synthetic private diagnostic')
  } finally { await f.close() }
})

test('a withdrawn or failed-ready owner never dispatches through its captured generation', async () => {
  const f = await local()
  try {
    const provider = owner(f.body), send = vi.spyOn(provider, 'deliver')
    let available = true
    provider.available = () => available
    provider.query = async () => { available = false; return { result: { status: 'missing' } } }
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(send).not.toHaveBeenCalled()
    available = true
    provider.ready = async () => { throw new Error('Synthetic private ready failure') }
    await f.outbox.deliver(100)
    expect(send).not.toHaveBeenCalled()
    expect(f.outbox.observations().find(delivery => delivery.payload.callbackId === f.body.callback.callbackId)?.lastDiagnostic?.cause.reason)
      .toBe('Callback owner query did not complete')
  } finally { await f.close() }
})

test('a previous unknown remains unknown after issuer refusal and mismatched settled identity', async () => {
  const f = await local()
  try {
    const retained = f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)!
    await f.engine().journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...retained, responseClass: 'unknown' } })])
    const provider = owner(f.body), send = vi.spyOn(provider, 'deliver')
    provider.query = async () => callbackFailure(f.body, 'issuer', 'Callback authority was revoked', 'unauthorized', 'none', 'evidence-revoked')
    f.h.ctx.provide('seatLocalCallbackOwner', provider)
    await f.outbox.deliver(0)
    expect(f.outbox.observations().find(delivery => delivery.payload.callbackId === f.body.callback.callbackId)).toMatchObject({ responseClass: 'unknown',
      lastDiagnostic: { stage: 'issuer', cause: { effectState: 'none', reasonCode: 'evidence-revoked' } } })
    provider.query = async () => ({ result: { status: 'settled', method: 'source.deliverCallback', result: {
      status: 'committed', callbackId: 'other' as T.CallbackId, payloadDigest: f.body.payloadDigest } } })
    await f.outbox.deliver(100)
    expect(f.engine().journal.projection.callbacks.get(f.body.callback.callbackId)?.responseClass).toBe('unknown')
    expect(send).not.toHaveBeenCalled()
  } finally { await f.close() }
})
