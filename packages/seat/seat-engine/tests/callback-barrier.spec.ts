/** Durable uncertainty permits exact queries but never a new delivery or journal frame. */
import { Context } from '@panedesk/cordis'
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { deliverRoutedCallback } from '../src/routed-callback.ts'
import type { CallbackChainRequest, CallbackRouterPort } from '../src/routed-callback-types.ts'
import { fact } from '../src/triggers.ts'
import { harness, seat } from './fixtures.ts'
import { admittedDefinition, persistCallback, callbackIssuer, principalId } from './routed-callback-fixture.ts'

for (const barrier of ['unknown', 'owner-unconfirmed'] as const) {
  test.each(['unknown', 'different-digest', 'different-callback', 'owner-recovering', 'settled-owner-recovering'] as const)(
    `keeps the durable ${barrier} barrier query-only for %s`, async (mode) => {
      const h = await harness()
      let engine = h.engine
      try {
        h.definitions.set(seat, admittedDefinition())
        const body = await persistCallback(engine)
        const retained = engine.journal.projection.callbacks.get(body.callback.callbackId)!
        await engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...retained, attempt: 1,
          phase: barrier === 'unknown' ? 'retry-due' : 'paused',
          responseClass: barrier === 'unknown' ? 'unknown' : 'protocol', nextDue: null,
          ...(barrier === 'owner-unconfirmed' ? { parkingClass: 'owner-unconfirmed' as const } : {}) } })])
        await engine.shutdown()
        engine = await h.start()
        const before = structuredClone(engine.journal.projection.callbacks.get(body.callback.callbackId))
        expect(before).toMatchObject({ responseClass: barrier === 'unknown' ? 'unknown' : 'protocol',
          phase: barrier === 'unknown' ? 'retry-due' : 'paused' })
        const seen: CallbackChainRequest[] = []
        const issuer = callbackIssuer(engine.options.nodeId)
        const result: T.NodeWorkChainOperationResult = mode === 'unknown' ? { status: 'pending', effectState: 'unknown' }
          : mode === 'owner-recovering' ? { status: 'pending', effectState: 'unknown', pendingReason: 'owner-recovering' }
            : mode === 'settled-owner-recovering' ? { status: 'settled', method: 'source.deliverCallback', result: {
              status: 'pending', callbackId: body.callback.callbackId, payloadDigest: body.payloadDigest, pendingReason: 'owner-recovering' } }
              : { status: 'settled', method: 'source.deliverCallback', result: { status: 'committed',
                callbackId: mode === 'different-callback' ? 'another-callback' as T.CallbackId : body.callback.callbackId,
                payloadDigest: mode === 'different-digest' ? 'another-digest' as T.SeatDigest : body.payloadDigest } }
        const router: CallbackRouterPort = { route: async (request) => {
          seen.push(structuredClone(request))
          if (request.method !== 'chain.operation') throw new Error('Uncertain callbacks must not be dispatched')
          return { method: request.method, status: 'ok', result }
        } }
        const ctx = new Context()
        try {
          ctx.provide('nodeWorkChain', issuer); ctx.provide('nodeWorkChainRouter', router)
          const commit = vi.spyOn(engine.journal, 'commit')
          for (let attempt = 0; attempt < 2; attempt++) {
            const outcome = await deliverRoutedCallback(ctx, engine, body)
            expect(outcome.result).toMatchObject({ status: 'rejected', error: { code: 'unavailable', effectState: 'unknown' } })
          }
          expect(seen.map(request => request.method)).toEqual(['chain.operation', 'chain.operation'])
          for (const request of seen) {
            expect(request.operationId).toBe(body.route.originalOperationId)
            expect(request.payload).toEqual({ key: { sourceNodeId: engine.options.nodeId, principalId,
              sourceId: body.route.sourceId, ownerEpoch: body.route.ownerEpoch, method: 'source.deliverCallback',
              operationId: body.route.originalOperationId, callbackId: body.callback.callbackId }, payloadDigest: body.payloadDigest })
          }
          expect(commit).not.toHaveBeenCalled()
          expect(engine.journal.projection.callbacks.get(body.callback.callbackId)).toEqual(before)
          expect(h.callbacks).toEqual([])
        } finally { await ctx.fiber.dispose() }
      } finally { await h.close() }
    })
}
