/** Real administration and journal transactions survive listener and engine replacement. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import { SeatEngine } from '../../../seat/seat-engine/src/engine.ts'
import { join } from 'node:path'
import type * as Seat from '@panedesk/dsh-seat'
import { harness, seat, trigger } from '../../../seat/seat-engine/tests/fixtures.ts'
import { mountAdmin } from '../src/runtime.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callAdmin } from '../src/client.ts'
import { callLoopback } from '../src/loopback.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { HOST_ADMIN_VERSION } from '../src/index.ts'

const limits = { maxFrameBytes: 262144, requestTimeoutMs: 5000, maxPending: 8 }
const taskId = 'task-admin' as Seat.SeatTaskId

test('queries approval registration, real creation and issued kinds after restart without exposing bodies', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  let stop: (() => Promise<void>) | undefined
  const directory = join(h.home, 'admin')
  const runtime = { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a', port: 0,
    maxStoreBytes: 1048576, maxOperations: 100 }
  const files = new PosixPrivateFiles(directory, process.getuid!())
  const restartedContext = new Context()
  let restartedEngine: SeatEngine | undefined
  try {
    await h.engine.accept({ ...trigger(), taskId })
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    stop = await mountAdmin(h.ctx, { runtime })
    const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
    const credential = (await files.read('credential', 64))!
    const params = { operationId: 'approve-query', queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion }
    expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ result: { status: 'approved' } })
    const registered = await callAdmin(files, 'engine.operation', { operationId: params.operationId }, limits)
    expect(registered).toMatchObject({ status: 'ok', result: { status: 'pending', approval: { queueItemId: pending.queueItemId },
      progress: { kind: 'pending', reason: 'approval' } } })
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    const before = await callAdmin(files, 'engine.operation', { operationId: params.operationId }, limits)
    expect(before).toMatchObject({ status: 'ok', result: { status: 'settled', result: { status: 'opened', phase: 'active' },
      progress: { kind: 'open', sessionId: h.creates[0] } } })
    const query = await callAdmin(files, 'engine.query', { limit: 100, taskId, seat, kind: 'local-operator' }, limits)
    expect(query).toMatchObject({ status: 'ok', result: { authorizations: { complete: true,
      facts: [{ kind: 'local-operator', operationId: params.operationId, taskIds: [taskId] }] } } })
    if (query.status !== 'ok' || query.method !== 'engine.query' || 'status' in query.result) throw new Error('Expected effect page')
    expect(query.result.effects.some(effect => effect.kind === 'queue/approved')).toBe(true)
    expect(JSON.stringify(query)).not.toContain('Begin the assigned task.')
    expect(JSON.stringify(query)).not.toContain(credential)
    const page = await callAdmin(files, 'engine.query', { limit: 1, taskId }, limits)
    if (page.status !== 'ok' || page.method !== 'engine.query' || 'status' in page.result) throw new Error('Expected query page')
    expect(page.result.complete).toBe(false)
    const next = await callAdmin(files, 'engine.query', { limit: 100, taskId, cursor: page.result.nextCursor,
      authorizationCursor: page.result.authorizations?.nextCursor }, limits)
    expect(next).toMatchObject({ result: { authorizations: { facts: [], complete: true } } })
    const forged = decodeRequest({ version: HOST_ADMIN_VERSION, method: 'engine.query', params: { limit: 1 },
      processEpoch: endpoint.processEpoch, requestId: 'forged', nonce: 'forged' })
    await expect(callLoopback(endpoint.port, { credential: '0'.repeat(64), epoch: endpoint.processEpoch }, forged, limits)).rejects.toThrow('refused')
    await stop(); stop = undefined
    await h.engine.shutdown()
    const engine = restartedEngine = new SeatEngine(restartedContext, h.engine.options, {
      seats: () => h.seatProvider, ledger: () => ({ snapshot: async () => h.state.snapshot }),
    })
    engine.registerExecutor(h.executor)
    await engine.ready()
    stop = await mountAdmin(restartedContext, { runtime })
    const restarted = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
    await expect(callLoopback(restarted.port, { credential, epoch: endpoint.processEpoch }, forged, limits)).rejects.toThrow('refused')
    const currentCredential = (await files.read('credential', 64))!
    expect(await callLoopback(restarted.port, { credential: currentCredential, epoch: restarted.processEpoch }, forged, limits))
      .toMatchObject({ code: 'admin-stale-epoch' })
    expect(await callAdmin(files, 'engine.operation', { operationId: params.operationId }, limits)).toMatchObject({ result: before.status === 'ok' ? before.result : {} })
    expect(await callAdmin(files, 'engine.query', { limit: 100, taskId, seat, kind: 'local-operator' }, limits))
      .toMatchObject({ result: { authorizations: { facts: [{ kind: 'local-operator', operationId: params.operationId }] } } })
    expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ result: { status: 'approved' } })
    expect(await callAdmin(files, 'engine.approve', { ...params, expectedStateVersion: params.expectedStateVersion + 1 }, limits))
      .toMatchObject({ status: 'rejected' })
    await engine.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await stop?.(); await restartedEngine?.shutdown(); await restartedContext.fiber.dispose(); await h.close() }
})

test('reports capacity blocking and a durable first-turn failure instead of treating approval as creation', async () => {
  const h = await harness({ nodeEngineWindowLimit: 0, ownerObserveIntervalMs: 60000 })
  let stop: (() => Promise<void>) | undefined
  try {
    await h.engine.accept({ ...trigger(), taskId })
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    const directory = join(h.home, 'admin')
    stop = await mountAdmin(h.ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    const params = { operationId: 'blocked', queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion }
    await callAdmin(files, 'engine.approve', params, limits)
    await h.engine.drive()
    expect(await callAdmin(files, 'engine.operation', { operationId: params.operationId }, limits))
      .toMatchObject({ result: { status: 'pending', progress: { kind: 'pending', reason: 'node-capacity' } } })
    expect(h.creates).toHaveLength(0)
    h.engine.options.config.nodeEngineWindowLimit = 1
    h.state.opening = 'failed'
    await h.engine.drive()
    expect(await callAdmin(files, 'engine.operation', { operationId: params.operationId }, limits))
      .toMatchObject({ result: { status: 'settled', result: { status: 'rejected' }, progress: { kind: 'open', phase: 'opening-failed' } } })
  } finally { await stop?.(); await h.close() }
})

test('rejects malformed authorization pages, kinds and progress received over the wire', () => {
  const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'query', nonce: 'query', processEpoch: 'epoch',
    method: 'engine.query', params: { limit: 1 } })
  expect(() => decodeRequest({ ...request, params: { limit: 1, kind: 'invented' } })).toThrow()
  expect(() => decodeRequest({ ...request, params: { limit: 1, authorizationCursor: { nodeId: 'node-a', sequence: -1, effectIndex: 0 } } })).toThrow()
  expect(() => decodeResponse({ ...request, status: 'ok', result: { effects: [], complete: true, watermark: 1,
    authorizations: { facts: [{}], complete: true, watermark: 1, legacyAttribution: 'none' } } }, request)).toThrow()
  const operation = decodeRequest({ ...request, method: 'engine.operation', params: { operationId: 'operation' } })
  expect(() => decodeResponse({ ...operation, status: 'ok', result: { status: 'missing', progress: { kind: 'invented' } } }, operation)).toThrow()
})
