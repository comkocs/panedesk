/** Routed delivery acknowledges only a matching durable owner receipt. */
import { expect, test, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeatEngine } from '../src/engine.ts'
import type * as T from '@panedesk/dsh-seat'
import { CallbackOutbox } from '../src/outbox.ts'
import { EngineFailures } from '../src/failure.ts'
import { callbackFailure } from '../src/routed-callback-types.ts'
import { SourceRegistry } from '../src/sources.ts'
import { digest, EngineError } from '../src/journal.ts'
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

test.each([false, true])('distinguishes a missing source from the same failure inside its callback: %s', async (insideCallback) => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  const failures = new EngineFailures(2000, () => {})
  let calls = 0
  if (insideCallback) sources.register({ sourceId, kinds: ['external'], maxRedeliveryMs: null,
    callback: async () => { calls++; throw new EngineError('source-not-found', 'Adapter rejected') } })
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, undefined, undefined,
    (cause, observation) => { failures.record('callback-delivery', cause, undefined, observation) })
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback),
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    expect(calls).toBe(insideCallback ? 1 : 0)
    expect(failures.snapshot()).toMatchObject({ code: 'source-not-found', retryable: !insideCallback })
    if (!insideCallback) {
      sources.register({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => { calls++ } })
      await outbox.deliver(config.callbackRetryInitialMs)
      expect(calls).toBe(1)
      expect(outbox.hasFailedDelivery()).toBe(false)
      failures.succeeded(failures.generation())
      expect(failures.snapshot()).toBeUndefined()
    }
  } finally { failures.close(); await outbox.close(); await sources.close(); await h.close() }
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

test.each(['issuer', 'peer-query'] as const)('preserves safe %s refusal through supervision and clears after delivery', async (stage) => {
  const h = await harness(), sources = new SourceRegistry(), request = callback()
  const failures = new EngineFailures(2000, () => {})
  let available = false, calls = 0
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, async () => {
    calls++
    return available ? { result: { status: 'committed', callbackId: request.callback.callbackId,
      payloadDigest: request.payloadDigest } } : callbackFailure(request, stage, 'Callback service is unavailable')
  }, undefined, (cause, observation) => { failures.record('callback-delivery', cause, undefined, observation) })
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    expect(failures.snapshot()).toMatchObject({ site: 'callback-delivery', code: 'unavailable', retryable: true })
    expect(failures.runnable()).toBe(false)
    available = true
    await outbox.deliver(config.callbackRetryInitialMs - 1)
    expect(calls).toBe(1)
    const generation = failures.generation()
    await outbox.deliver(config.callbackRetryInitialMs)
    expect(calls).toBe(2)
    expect(outbox.hasFailedDelivery()).toBe(false)
    expect(h.engine.journal.projection.callbacks.get(request.callback.callbackId)?.phase).toBe('delivered')
    failures.succeeded(generation)
    expect(failures.snapshot()).toBeUndefined()
  } finally { failures.close(); await outbox.close(); await sources.close(); await h.close() }
})

test.each(['none', 'partial', 'committed', 'unknown'] as const)('the engine resumes only a no-effect routed refusal: %s', async (effectState) => {
  const home = await mkdtemp(join(tmpdir(), 'routed-engine-recovery-')), ctx = new Context(), request = callback()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let available = false
  const seen: T.DeliverSourceCallbackRequest[] = []
  const engine = new SeatEngine(ctx, { home, nodeId, config: { ...config,
    failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } } }, {
    seats: () => undefined, ledger: () => undefined,
    deliverCallback: async (input) => {
      seen.push(structuredClone(input))
      return available ? { result: { status: 'committed', callbackId: input.callback.callbackId,
        payloadDigest: input.payloadDigest } } : callbackFailure(input, 'issuer', 'Callback issuer is unavailable', 'unavailable', effectState)
    },
  })
  try {
    await engine.ready()
    await engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await engine.drive()
    expect((await engine.nodeStatus()).failure).toMatchObject({ site: 'callback-delivery', retryable: effectState === 'none' })
    expect(seen).toEqual([request])
    available = true
    await vi.advanceTimersByTimeAsync(1999)
    expect(seen).toEqual([request])
    await vi.advanceTimersByTimeAsync(1)
    await engine.drive()
    if (effectState === 'none') {
      expect(seen).toEqual([request, request])
      expect((await engine.nodeStatus()).failure).toBeUndefined()
      expect((await engine.nodeStatus()).engine).toBe('running')
      expect(engine.journal.projection.callbacks.get(request.callback.callbackId)?.phase).toBe('delivered')
    } else {
      expect(seen).toEqual([request])
      expect((await engine.nodeStatus()).failure?.retryable).toBe(false)
      expect((await engine.nodeStatus()).engine).toBe('unavailable')
    }
  } finally {
    try { await engine.shutdown(); await ctx.fiber.dispose() }
    finally { log.mockRestore(); vi.useRealTimers(); await rm(home, { recursive: true, force: true }) }
  }
})

test.each(['none', 'partial', 'committed', 'unknown'] as const)('contains an issuer refusal only with confirmed no effects: %s', async (effectState) => {
  const home = await mkdtemp(join(tmpdir(), 'issuer-refusal-')), ctx = new Context(), request = callback()
  const other = callback()
  other.callback = { ...other.callback, callbackId: 'other-callback' as T.CallbackId, triggerId: 'other-trigger' as T.TriggerId }
  other.route = { ...other.route, triggerId: other.callback.triggerId }
  const { payloadDigest: _previousDigest, ...otherPayload } = other
  other.payloadDigest = digest(otherPayload)
  const seen: T.CallbackId[] = [], changed = vi.fn()
  ctx.on('seat/diagnostics-changed', changed)
  const engine = new SeatEngine(ctx, { home, nodeId, config: { ...config,
    failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } } }, {
    seats: () => undefined, ledger: () => undefined,
    deliverCallback: async (input) => {
      seen.push(input.callback.callbackId)
      return input.callback.callbackId === request.callback.callbackId
        ? callbackFailure(input, 'issuer', 'Original callback authority was revoked', 'unauthorized', effectState, 'evidence-revoked')
        : { result: { status: 'committed', callbackId: input.callback.callbackId, payloadDigest: input.payloadDigest } }
    },
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await engine.ready()
    await engine.journal.commit(() => [request, other].map(body => fact({ kind: 'callback/pending', data: {
      payload: body.callback, payloadDigest: digest(body.callback), nodeWorkChain: body,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })))
    await engine.drive()
    if (effectState !== 'none') {
      expect((await engine.nodeStatus()).failure).toMatchObject({ retryable: false })
      expect(seen).toEqual([request.callback.callbackId])
      return
    }
    expect(await engine.nodeStatus()).toMatchObject({ engine: 'running' })
    expect((await engine.nodeStatus()).failure).toBeUndefined()
    expect(seen).toEqual([request.callback.callbackId, other.callback.callbackId])
    expect(engine.journal.projection.callbacks.get(request.callback.callbackId)).toMatchObject({
      phase: 'paused', responseClass: 'authentication', nextDue: null })
    expect(await engine.nodeStatus()).toMatchObject({ callbackFailures: [{ callbackId: request.callback.callbackId,
      seat, code: 'unauthorized' }] })
    expect(changed).toHaveBeenCalled()
    const resolution: T.CallbackResolveRequest = { callbackId: request.callback.callbackId, expectedAttempt: 1, action: 'abandon' }
    const operationId = 'abandon-refused-callback' as T.SeatOperationId
    const entry = engine.authorizationIssuers.register({ identity: { kind: 'local-operator', origin: 'manual', nodeId,
      principalId: 'operator' as T.SeatPrincipalId, taskIds: [], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'operator', policyRevision: 1 }) })
    try {
      const grant = await entry.issuer.check({ operationId, requestDigest: digest(resolution) })
      if ('status' in grant) throw new Error('Operator refused')
      expect(await engine.callbackResolve(resolution, grant)).toMatchObject({ status: 'ok', phase: 'abandoned' })
      expect((await engine.nodeStatus())).not.toHaveProperty('callbackFailures')
      await engine.drive()
      expect(seen).toHaveLength(2)
    } finally { entry.dispose() }
  } finally { await engine.shutdown(); await ctx.fiber.dispose(); log.mockRestore(); await rm(home, { recursive: true, force: true }) }
})

test.each(['principal-mismatch', 'node-mismatch'] as const)('does not contain an issuer refusal with conflicting identity: %s', async (reasonCode) => {
  const h = await harness(), sources = new SourceRegistry(), request = callback(), failures = new EngineFailures(2000, () => {})
  const outbox = new CallbackOutbox(h.engine.journal, sources, config,
    async body => callbackFailure(body, 'issuer', 'Issued identity does not match', 'unauthorized', 'none', reasonCode),
    undefined, (cause, observation) => { failures.record('callback-delivery', cause, undefined, observation) })
  try {
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
      payload: request.callback, payloadDigest: digest(request.callback), nodeWorkChain: request,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
    await outbox.deliver(0)
    expect(failures.snapshot()).toMatchObject({ code: 'unauthorized', retryable: false })
    expect(outbox.hasFailedDelivery()).toBe(true)
  } finally { failures.close(); await outbox.close(); await sources.close(); await h.close() }
})

test('contains an issuer refusal after retry without blocking other chains or overtaking its own chain', async () => {
  const h = await harness(), sources = new SourceRegistry(), request = callback(), successor = callback(), other = callback()
  successor.callback = { ...successor.callback, callbackId: 'successor' as T.CallbackId, stateVersion: 2 }
  other.callback = { ...other.callback, callbackId: 'independent' as T.CallbackId, triggerId: 'independent' as T.TriggerId }
  other.route = { ...other.route, triggerId: other.callback.triggerId }
  for (const body of [successor, other]) {
    const { payloadDigest: _digest, ...payload } = body
    body.payloadDigest = digest(payload)
  }
  const failures = new EngineFailures(2000, () => {}), seen: T.CallbackId[] = []
  let refused = false
  const outbox = new CallbackOutbox(h.engine.journal, sources, config, async (body) => {
    seen.push(body.callback.callbackId)
    if (body.callback.callbackId !== request.callback.callbackId) return { result: {
      status: 'committed', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest } }
    return refused ? callbackFailure(body, 'issuer', 'Original account is unavailable', 'unauthorized', 'none')
      : callbackFailure(body, 'issuer', 'Issuer service is unavailable')
  }, undefined, (cause, observation) => { failures.record('callback-delivery', cause, undefined, observation) })
  try {
    await h.engine.journal.commit(() => [request, successor, other].map(body => fact({ kind: 'callback/pending', data: {
      payload: body.callback, payloadDigest: digest(body.callback), nodeWorkChain: body,
      attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })))
    await outbox.deliver(0)
    expect(failures.snapshot()).toMatchObject({ retryable: true })
    refused = true
    await outbox.deliver(config.callbackRetryInitialMs)
    expect(seen).toEqual([request.callback.callbackId, request.callback.callbackId, other.callback.callbackId])
    expect(outbox.hasFailedDelivery()).toBe(false)
    failures.succeeded(failures.generation())
    expect(failures.snapshot()).toBeUndefined()
    expect(h.engine.journal.projection.callbacks.get(successor.callback.callbackId)).toMatchObject({ phase: 'pending', attempt: 0 })
    await outbox.deliver(config.callbackRetryMaxMs)
    expect(seen).toHaveLength(3)
  } finally { failures.close(); await outbox.close(); await sources.close(); await h.close() }
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
