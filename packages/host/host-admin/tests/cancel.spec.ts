/** Local cancellation preserves provider refusals and durable transport replay. */
import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import { harness, trigger } from '../../../seat/seat-engine/tests/fixtures.ts'
import { decodeRequest as decodeNodeRequest } from '../../../seat/node-link/src/codec.ts'
import { NODE_LINK_VERSION } from '../../../seat/node-link/src/index.ts'
import { mountAdmin } from '../src/runtime.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callAdmin } from '../src/client.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { createHostAdminExecutor } from '../src/executor.ts'
import { digest } from '../src/json.ts'
import { HOST_ADMIN_VERSION, type HostAdminAuthority } from '../src/index.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
const params = { operationId: 'cancel-a', queueItemId: 'queue-a', expectedStateVersion: 1 }
const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'cancel-request', processEpoch: 'epoch-a',
  nonce: 'cancel-nonce', method: 'engine.cancel', params })

test('cancels pending work once and replays the retained receipt after restart', async () => {
  const restartedContext = new Context()
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let stop: (() => Promise<void>) | undefined
  try {
    await h.engine.accept(trigger())
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    const directory = join(h.home, 'admin')
    const runtime = { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a', port: 0,
      maxStoreBytes: 1048576, maxOperations: 100 }
    stop = await mountAdmin(h.ctx, { runtime })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    const target = { ...params, queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion, reason: 'Operator cancelled queued work' }
    const result = { status: 'cancelled', queueItemId: pending.queueItemId, stateVersion: pending.stateVersion + 1 }
    expect(await callAdmin(files, 'engine.cancel', target, limits)).toMatchObject({ status: 'ok', result })
    expect(await callAdmin(files, 'engine.cancel', target, limits)).toMatchObject({ status: 'ok', result })
    expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
    expect(h.engine.journal.projection.decisions.flatMap(frame => frame.effects).filter(effect => effect.kind === 'queue/cancelled')).toHaveLength(1)
    const receipt = await callAdmin(files, 'engine.operation', { operationId: target.operationId }, limits)
    expect(receipt).toMatchObject({ status: 'ok', result: { status: 'settled', result: { status: 'cancelled', cancellation: {
      reason: target.reason, queueItemId: target.queueItemId } } } })
    await stop(); stop = undefined
    stop = await mountAdmin(restartedContext, { runtime })
    expect(await callAdmin(files, 'engine.cancel', target, limits)).toMatchObject({ status: 'ok', result })
    expect(await callAdmin(files, 'engine.cancel', { ...target, expectedStateVersion: target.expectedStateVersion + 1 }, limits))
      .toMatchObject({ status: 'rejected', code: 'admin-unauthorized' })
    await h.engine.drive()
    expect(h.creates).toHaveLength(0)
  } finally { await stop?.(); await restartedContext.fiber.dispose(); await h.close() }
})

test('preserves unknown-target and stale-version engine refusals without cancelling work', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let stop: (() => Promise<void>) | undefined
  try {
    await h.engine.accept(trigger())
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    const directory = join(h.home, 'admin')
    stop = await mountAdmin(h.ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    for (const target of [params, { ...params, operationId: 'stale-version', queueItemId: pending.queueItemId,
      expectedStateVersion: pending.stateVersion + 1 }]) {
      const decoded = decodeRequest({ ...request, params: target })
      if (decoded.method !== 'engine.cancel') throw new Error('Expected cancellation')
      const result = await h.engine.cancel(decoded.params)
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
      expect(await callAdmin(files, 'engine.cancel', target, limits)).toMatchObject({ status: 'ok', result })
    }
    expect((await h.engine.pending({ limit: 10 })).items).toEqual([pending])
  } finally { await stop?.(); await h.close() }
})

test('passes cancellation to the engine without issuing a grant', async () => {
  const authority: HostAdminAuthority = { principalId: 'operator-a' as HostAdminAuthority['principalId'],
    authorizationRef: 'authority-a' as HostAdminAuthority['authorizationRef'], kind: 'local-operator', methods: ['engine.cancel'] }
  const cancel = vi.fn(async (_input: Seat.CancelPendingSeatRequest) => ({ status: 'cancelled' as const, queueItemId: params.queueItemId as Seat.QueueItemId, stateVersion: 2 }))
  const executor = createHostAdminExecutor({ nodeId: 'node-a' as Seat.SeatNodeId,
    engine: { cancel } as Pick<Seat.SeatEngineService, 'cancel'> as Seat.SeatEngineService })
  expect(await executor.execute(request, authority)).toMatchObject({ status: 'ok', result: { status: 'cancelled' } })
  expect(cancel).toHaveBeenCalledWith(params)
  expect(() => decodeNodeRequest({ version: NODE_LINK_VERSION, requestId: 'request-a', sourceNodeId: 'node-b', targetNodeId: 'node-a',
    operationId: params.operationId, deadline: new Date().toISOString(), hop: 1, method: 'engine.cancel', payload: params,
    payloadDigest: digest(params), delegation: {} })).toThrow('Node frame rejected')
})

test('validates cancellation requests and results using the existing seat codec', () => {
  expect(decodeRequest(request)).toEqual(request)
  for (const patch of [{ expectedStateVersion: -1 }, { principalId: 'operator-a' }, { queueItemId: '' }]) {
    expect(() => decodeRequest({ ...request, params: { ...params, ...patch } })).toThrow()
  }
  const response = { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method,
    status: 'ok', result: { status: 'cancelled', queueItemId: params.queueItemId, stateVersion: 2 } }
  expect(decodeResponse(response, request)).toEqual(response)
  expect(() => decodeResponse({ ...response, result: { ...response.result, status: 'approved' } }, request)).toThrow()
  expect(() => decodeResponse({ ...response, result: { ...response.result, stateVersion: -1 } }, request)).toThrow()
})
