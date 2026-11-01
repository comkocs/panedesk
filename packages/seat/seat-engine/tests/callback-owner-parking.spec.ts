/** Owner parking remains queryable while unrelated worker callbacks continue. */
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '../src/engine.ts'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackChainRequest, CallbackIssuerPort, CallbackRouterPort } from '../src/routed-callback-types.ts'
import { digest } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { config, nodeId, seat } from './fixtures.ts'
import { admittedDefinition, persistCallback, principalId } from './routed-callback-fixture.ts'

test.each([
  ['callback-desk-unreachable', 'resume'],
  ['callback-writeback-step-paused', 'abandon'],
  ['callback-owner-transient-limit-reached', 'resume'],
  ['callback-writeback-step-paused', 'missing'],
] as const)('follows owner %s through %s without stopping or replaying business', async (code, action) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const home = await mkdtemp(join(tmpdir(), 'callback-owner-parking-')), ctx = new Context()
  const seen: CallbackChainRequest[] = []
  let body: T.DeliverSourceCallbackRequest, sent = false, resolved = false, ownerPending = false
  const engine: SeatEngine = new SeatEngine(ctx, { home, nodeId, config: { ...config, ownerObserveIntervalMs: 60000,
    failureRecovery: { retryInitialMs: 2000, ownerReleaseMaxAttempts: 3 } } }, {
    seats: () => ({ resolve: async () => admittedDefinition(), list: async () => { throw new Error('Unused') },
      close: async () => { throw new Error('Unused') } }),
    ledger: () => ({ snapshot: async () => ({ asOf: 1, watermarks: {}, complete: true, rows: [] }) }),
    deliverCallback: (input, observation) => deliverRoutedCallback(ctx, engine, input, observation),
  })
  const receipt = (): T.DeliverSourceCallbackResult => resolved && action === 'resume'
    ? { status: 'committed', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest }
    : !resolved && code === 'callback-desk-unreachable' && Date.now() < 1900000
      ? { status: 'pending', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest, pendingReason: 'desk-unreachable' }
      : { status: 'paused', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest,
        error: { code: 'unavailable', message: 'Owner requires resolution', alternative: 'Resolve on owner', retryable: false,
          effectState: 'unknown', cause: { domain: 'desk', code: resolved ? 'callback-manually-abandoned' : code,
            reason: 'Owner retained original callback', operationId: body.route.originalOperationId,
            nodeId: body.route.sourceOwnerNodeId, retryable: false, effectState: 'unknown' } } }
  const issuer: CallbackIssuerPort = { outboxIssuer: async () => engine.authorizationIssuers.register({ identity: {
    kind: 'human', principalId, nodeId, origin: 'manual', seat, taskIds: [], policyRevision: 1 },
  current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) }).issuer }
  const router: CallbackRouterPort = { route: async (request) => {
    seen.push(structuredClone(request))
    if (request.method === 'chain.operation') {
      expect(request.payload).toEqual({ key: { sourceNodeId: nodeId, principalId, sourceId: body.route.sourceId,
        ownerEpoch: body.route.ownerEpoch, method: 'source.deliverCallback', operationId: body.route.originalOperationId,
        callbackId: body.callback.callbackId }, payloadDigest: body.payloadDigest })
      if (ownerPending) return { method: request.method, status: 'ok', result: resolved
        ? { status: 'missing' } : { status: 'pending', effectState: 'none', pendingReason: 'writeback-pending' } }
      return { method: request.method, status: 'ok', result: sent
        ? { status: 'settled', method: 'source.deliverCallback', result: receipt() } : { status: 'missing' } }
    }
    expect(request.method).toBe('source.deliverCallback'); expect(request.payload).toEqual(body)
    expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.responseClass).toBe('unknown')
    sent = true
    return { method: 'source.deliverCallback', status: 'ok', result: receipt() }
  } }
  ctx.provide('nodeWorkChain', issuer); ctx.provide('nodeWorkChainRouter', router)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await engine.ready(); body = await persistCallback(engine)
    engine.registerPreopenRetention({ sourceId: body.route.sourceId, sourceOwnerNodeId: body.route.sourceOwnerNodeId, limitMs: 9000000 })
    await engine.drive()
    vi.setSystemTime(1900000); await engine.drive()
    expect(await engine.nodeStatus()).toMatchObject({ engine: 'running' })
    expect((await engine.nodeStatus()).failure).toBeUndefined()
    expect((await engine.callbackObservations({ limit: 10 })).items[0]).toMatchObject({ phase: 'paused',
      parkingClass: 'owner-unconfirmed', lastDiagnostic: { cause: { code } } })
    const local = vi.fn(async () => {})
    const sourceId = 'independent-source' as T.SeatSourceId
    const unregister = engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: local })
    try {
      const payload = { ...body.callback, sourceId, callbackId: 'independent-callback' as T.CallbackId }
      await engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { payload, payloadDigest: digest(payload),
        attempt: 0, phase: 'pending', nextDue: null, responseClass: null } })])
      vi.setSystemTime(1900010); await engine.drive()
      expect(local).toHaveBeenCalledTimes(1)
      expect((await engine.nodeStatus()).failure).toBeUndefined()
      if (action === 'missing') {
        ownerPending = true
        vi.setSystemTime(1900100); await engine.drive()
        expect((await engine.nodeStatus()).failure).toBeUndefined()
        resolved = true
        vi.setSystemTime(2000000); await engine.drive()
        expect(seen.filter(request => request.method === 'source.deliverCallback')).toHaveLength(1)
        expect(await engine.nodeStatus()).toMatchObject({ engine: 'unavailable', failure: { retryable: false } })
        return
      }
      resolved = true
      vi.setSystemTime(1900100); await engine.drive()
      expect(engine.journal.projection.callbacks.get(body.callback.callbackId)?.phase).toBe(action === 'resume' ? 'delivered' : 'abandoned')
      expect(seen.filter(request => request.method === 'source.deliverCallback')).toHaveLength(1)
      expect((await engine.nodeStatus()).failure).toBeUndefined()
    } finally { await unregister() }
  } finally {
    await engine.shutdown(); await ctx.fiber.dispose(); log.mockRestore(); vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  }
})
