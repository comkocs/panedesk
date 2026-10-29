/** Routed delivery acknowledges only a matching durable owner receipt. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { SourceRegistry } from '../src/sources.ts'
import { digest } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { config, harness, nodeId, projectId, seat, sourceId } from './fixtures.ts'

function callback(): T.DeliverSourceCallbackRequest {
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback' as T.CallbackId,
    sourceId, triggerId: 'trigger' as T.TriggerId, stateVersion: 1, seat, title: 'Frozen title',
    sessionId: 'session' as T.SeatCallbackPayload['sessionId'] & string, nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
  const body = { callback: payload, route: { sourceId, sourceOwnerNodeId: 'owner' as T.SeatNodeId,
    ownerEpoch: 'epoch' as T.OwnerEpoch, triggerId: payload.triggerId,
    originalOperationId: 'operation' as T.SeatOperationId, targetNodeId: nodeId, snapshotDigest: digest('opening'),
    callbackPath: { kind: 'source' as const, sourceId }, modeCeiling: { mode: 'auto' as const,
      policy: { sourceId, projectId, revision: 1 } } },
  modelEvidence: { status: 'missing' as const, sessionId: payload.sessionId, nodeId, observedAt: '2026-01-01T00:00:00Z' } }
  return { ...body, payloadDigest: digest(body) }
}

test('retains a routed callback without a sender and never falls back to a same-named local source', async () => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  let localCalls = 0
  sources.register({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => { localCalls++ } })
  const outbox = new CallbackOutbox(h.engine.journal, sources, config)
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    expect(localCalls).toBe(0)
    expect(h.engine.journal.projection.callbacks.get(request.callback.callbackId)).toMatchObject({ phase: 'retry-due', attempt: 1 })
  } finally { await outbox.close(); await sources.close(); await h.close() }
})

test.each(['digest', 'node', 'session'] as const)('rejects inconsistent retained %s evidence before append or sending', async (changed) => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  let calls = 0
  if (changed === 'digest') request.payloadDigest = digest('changed')
  else {
    if (changed === 'node') request.modelEvidence.nodeId = 'other' as T.SeatNodeId
    else request.modelEvidence.sessionId = 'other' as NonNullable<T.SeatCallbackPayload['sessionId']>
    const { payloadDigest: _digest, ...body } = request
    request.payloadDigest = digest(body)
  }
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, async () => {
    calls++
    return { result: { status: 'committed', callbackId: request.callback.callbackId, payloadDigest: request.payloadDigest } }
  })
  try {
    await expect(h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])).rejects.toThrow('Frozen callback evidence does not match')
    await outbox.deliver(0)
    expect(calls).toBe(0)
    expect(h.engine.journal.projection.callbacks.has(request.callback.callbackId)).toBe(false)
  } finally { await outbox.close(); await sources.close(); await h.close() }
})

test('supervises real failures but leaves a matching pending owner receipt to the outbox backoff', async () => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  const failures: unknown[] = []
  let committed = false, calls = 0
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, async () => {
    calls++
    return { result: { status: committed ? 'committed' : 'pending', callbackId: request.callback.callbackId,
      payloadDigest: request.payloadDigest } }
  }, undefined, (failure) => { failures.push(failure) })
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    expect(failures).toEqual([])
    expect(h.engine.journal.projection.callbacks.get(request.callback.callbackId)).toMatchObject({
      phase: 'retry-due', responseClass: 'transient', attempt: 1,
      nextDue: new Date(config.callbackRetryInitialMs).toISOString() })
    committed = true
    await outbox.deliver(config.callbackRetryInitialMs - 1)
    expect(calls).toBe(1)
    await outbox.deliver(config.callbackRetryInitialMs)
    expect(calls).toBe(2)
    expect(failures).toEqual([])
    expect(h.engine.journal.projection.callbacks.get(request.callback.callbackId)?.phase).toBe('delivered')
  } finally { await outbox.close(); await sources.close(); await h.close() }
})

test.each(['pending', 'committed', 'mismatch', 'paused'] as const)('classifies the owner %s receipt and freezes retry input', async (status) => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  const seen: T.DeliverSourceCallbackRequest[] = []
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, async (input) => {
    seen.push(structuredClone(input))
    input.modelEvidence.observedAt = '2026-02-01T00:00:00Z'
    const identity = { callbackId: request.callback.callbackId,
      payloadDigest: status === 'mismatch' ? digest('other') : request.payloadDigest }
    return { result: status === 'paused' ? { status, ...identity, error: { code: 'unauthorized',
      message: 'Owner permission rejected', alternative: 'Review owner permission', effectState: 'none', retryable: false } }
      : { status: status === 'pending' ? 'pending' : 'committed', ...identity } }
  })
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    const delivery = h.engine.journal.projection.callbacks.get(request.callback.callbackId)!
    expect(delivery.phase).toBe(status === 'committed' ? 'delivered' : status === 'pending' ? 'retry-due' : 'paused')
    expect(delivery.nodeWorkChain).toEqual(request)
    await outbox.deliver(100)
    expect(seen).toEqual(status === 'pending' ? [request, request] : [request])
  } finally { await outbox.close(); await sources.close(); await h.close() }
})
