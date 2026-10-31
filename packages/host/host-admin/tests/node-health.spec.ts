/** Health reads stay observational and operator actions retain the existing grant checks. */
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import { harness, seat } from '../../../seat/seat-engine/tests/fixtures.ts'
import { digest } from '../../../seat/seat-engine/src/journal.ts'
import { fact } from '../../../seat/seat-engine/src/triggers.ts'
import { SeatEngine } from '../../../seat/seat-engine/src/engine.ts'
import { join } from 'node:path'
import { readNodeHealth, executeNodeOperator } from '../src/node-health.ts'
import { decodeRequest } from '../src/codec.ts'
import type { HostAdminAuthority, NodeHealthPeer } from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers() })
const nodeId = 'node-b' as Seat.SeatNodeId
const authority: HostAdminAuthority = { principalId: 'operator-a' as Seat.SeatPrincipalId,
  authorizationRef: 'owner-entry' as Seat.AuthorizationRef, kind: 'local-operator', methods: ['node.rebuild'] }
const request = decodeRequest({ version: 'host-admin/v1', requestId: 'request-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'node.rebuild', params: { peerNodeId: nodeId } })

test('reports missing providers explicitly without installing an engine', async () => {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  expect(await readNodeHealth(ctx, 10)).toEqual({ nodes: [], callbacks: [], callbacksAvailable: false,
    callbacksComplete: false, sourceOperations: [], sourceAvailable: false })
  expect(ctx.get('seatEngine')).toBeUndefined()
  expect(await executeNodeOperator(ctx, request, authority, () => true)).toBeNull()
})

test('joins local identity with bounded peer events and the live observation capability', async () => {
  const h = await harness(); cleanups.push(h.close)
  const events = Array.from({ length: 25 }, (_, sequence) => ({ sequence, at: new Date(sequence).toISOString(),
    kind: 'authentication-succeeded' as const, safeReason: null }))
  const peer: NodeHealthPeer = { nodeId, nodeName: 'Remote', reachable: false, status: null,
    safeReason: 'node-tunnel-exhausted', exhausted: true, lastHeartbeatAt: new Date(1).toISOString(), events }
  h.ctx.provide('hostAdminNodeHealth', { status: async () => [peer, { ...peer, nodeId: 'node-a' as Seat.SeatNodeId }] })
  h.ctx.provide('hostAdminTransport', { rebuildTransport: async () => ({ status: 'rebuilt' }) })
  const observe = vi.spyOn(h.engine, 'callbackObservations').mockResolvedValue({ items: [], complete: true })
  const view = await readNodeHealth(h.ctx, 10)
  expect(observe).toHaveBeenCalledWith({ limit: 10, phase: 'paused' })
  expect(view).toMatchObject({ callbacksAvailable: true, callbacksComplete: true, nodes: [
    { nodeId: 'node-a', local: true, linkState: 'local', lastHeartbeatAt: null, rebuildable: false },
    { nodeId, local: false, engine: 'unavailable', linkState: 'exhausted', openWindows: null, limit: null,
      safeReason: 'node-tunnel-exhausted', lastHeartbeatAt: new Date(1).toISOString(), rebuildable: true },
  ] })
  expect(view.nodes[1]?.events).toEqual(events.slice(-20))
})

test('reads unflushed retry counters without mutating the journal and filters parking before the limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
  const base = await harness(); cleanups.push(base.close)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  const engine = new SeatEngine(ctx, { ...base.engine.options, home: join(base.home, 'observed'),
    config: { ...base.engine.options.config, failureRecovery: { retryInitialMs: 1 } } }, {
    seats: () => base.seatProvider, ledger: () => ({ snapshot: async () => base.state.snapshot }),
  })
  cleanups.push(() => engine.shutdown())
  await engine.ready()
  const payload: Seat.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback-live' as Seat.CallbackId,
    sourceId: 'missing-source' as Seat.SeatSourceId, triggerId: null, stateVersion: 1, seat,
    sessionId: 'session-a' as NonNullable<Seat.SeatCallbackPayload['sessionId']>, title: 'Window',
    nodeId: engine.options.nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
  await engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
    payload, payloadDigest: digest(payload), attempt: 0, phase: 'pending', responseClass: null, nextDue: null,
  } })])
  const h = { engine, ctx }
  await h.engine.drive()
  const committed = structuredClone(h.engine.journal.projection.callbacks.get(payload.callbackId))
  const first = await h.engine.callbackObservations({ limit: 10 })
  const due = first.items[0]?.nextDue
  if (due === null || due === undefined) throw new Error('Retry observation has no due time')
  vi.setSystemTime(Date.parse(due)); await h.engine.drive()
  const live = await h.engine.callbackObservations({ limit: 10 })
  expect(live.items[0]?.attempt).toBe(2)
  expect(h.engine.journal.projection.callbacks.get(payload.callbackId)).toEqual(committed)
  const parkedPayload = { ...payload, callbackId: 'callback-parked' as Seat.CallbackId }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: {
    payload: parkedPayload, payloadDigest: digest(parkedPayload), attempt: 3, phase: 'paused',
    responseClass: 'transient', parkingClass: 'transport-transient', nextDue: null,
  } })])
  const view = await readNodeHealth(h.ctx, 1)
  expect(view.callbacks).toMatchObject([{ callbackId: 'callback-parked', source: payload.sourceId, count: 3 }])
  expect(view.callbacksComplete).toBe(true)
  expect((await h.engine.callbackObservations({ limit: 10 })).items[0]?.attempt).toBe(2)
})

test('keeps authority kind, allowed methods and invocation lifetime ahead of tunnel effects', async () => {
  const h = await harness(); cleanups.push(h.close)
  const rebuild = vi.fn(async () => ({ status: 'rebuilt' as const }))
  h.ctx.provide('hostAdminTransport', { rebuildTransport: rebuild })
  expect(await executeNodeOperator(h.ctx, request, { ...authority, kind: 'node-delegation' }, () => true)).toBeNull()
  expect(await executeNodeOperator(h.ctx, request, authority, () => false)).toBeNull()
  expect(await executeNodeOperator(h.ctx, request, { ...authority, methods: [] }, () => true))
    .toMatchObject({ status: 'rejected', code: 'admin-unauthorized' })
  expect(rebuild).not.toHaveBeenCalled()
  expect(await executeNodeOperator(h.ctx, request, authority, () => true)).toMatchObject({ status: 'ok', result: { status: 'rebuilt' } })
  expect(rebuild).toHaveBeenCalledExactlyOnceWith(nodeId)
})
