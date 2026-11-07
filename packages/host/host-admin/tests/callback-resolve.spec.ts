/** Callback operator resolution uses the authenticated running host and durable engine. */
import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { harness, nodeId, seat, sourceId } from '../../../seat/seat-engine/tests/fixtures.ts'
import { digest } from '../../../seat/seat-engine/src/journal.ts'
import { fact } from '../../../seat/seat-engine/src/triggers.ts'
import { mountAdmin } from '../src/runtime.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callAdmin } from '../src/client.ts'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { HOST_ADMIN_VERSION } from '../src/index.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
async function fixture() {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'resolve-opened' as T.CallbackId,
    sourceId, triggerId: 'resolve-trigger' as T.TriggerId, stateVersion: 1, seat, title: 'Operator resolution',
    sessionId: 'resolve-session' as NonNullable<T.SeatCallbackPayload['sessionId']>, nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
  const delivery: T.SeatCallbackDelivery = { payload, payloadDigest: digest(payload), phase: 'paused', attempt: 3,
    nextDue: null, responseClass: 'transient' }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: delivery })])
  const directory = join(h.home, 'admin')
  const stop = await mountAdmin(h.ctx, { runtime: { ...limits, directory, nodeId, principalId: 'operator-a', port: 0,
    maxStoreBytes: 1048576, maxOperations: 100 } })
  const files = new PosixPrivateFiles(directory, process.getuid!())
  const target = { callbackId: payload.callbackId, action: 'resume' as const, expectedAttempt: 3 }
  return { ...h, payload, delivery, files, target, stop }
}

test('C11-d resumes once, delivers the original callback, and replays current state after completion', async () => {
  const h = await fixture()
  try {
    const count = h.engine.journal.projection.sequence
    for (let i = 0; i < 2; i++) expect(await callAdmin(h.files, 'engine.callbackResolve', h.target, limits))
      .toMatchObject({ status: 'ok', result: { status: 'ok', phase: 'retry-due', attempt: 3 } })
    expect(h.engine.journal.projection.sequence).toBe(count + 1)
    const mutation = h.engine.journal.projection.authorizationDecisions.at(-1)!
    expect(mutation.effects.map(effect => effect.kind)).toEqual(['callback/attempted'])
    await h.engine.drive(); await h.engine.shutdown()
    expect(h.engine.journal.projection.callbacks.get(h.payload.callbackId)).toMatchObject({ phase: 'delivered', attempt: 4, payload: h.payload })
    const restarted = await h.start()
    const before = restarted.journal.projection.sequence
    expect(await restarted.callbackResolve(h.target)).toMatchObject({ status: 'ok', phase: 'delivered', attempt: 4 })
    expect(restarted.journal.projection.sequence).toBe(before)
  } finally { await h.stop(); await h.close() }
})

test('C11-d abandons once and permits the same-group ended callback on the next drive', async () => {
  const h = await fixture()
  try {
    const ended: T.SeatCallbackPayload = { ...h.payload, kind: 'window-ended', callbackId: 'resolve-ended' as T.CallbackId,
      stateVersion: 2, reason: 'manual', endedAt: new Date().toISOString(), selfReport: null, selfReportStatus: 'not-submitted' }
    await h.engine.journal.commit(() => [fact({ kind: 'callback/pending', data: { payload: ended, payloadDigest: digest(ended),
      phase: 'pending', attempt: 0, nextDue: null, responseClass: null } })])
    await h.engine.drive()
    expect(h.engine.journal.projection.callbacks.get(ended.callbackId)?.attempt).toBe(0)
    const before = h.engine.journal.projection.sequence
    for (let i = 0; i < 2; i++) expect(await callAdmin(h.files, 'engine.callbackResolve', { ...h.target, action: 'abandon' }, limits))
      .toMatchObject({ status: 'ok', result: { status: 'ok', phase: 'abandoned', attempt: 3 } })
    expect(h.engine.journal.projection.sequence).toBe(before + 1)
    await h.engine.drive(); await h.engine.shutdown()
    expect(h.engine.journal.projection.callbacks.get(ended.callbackId)?.phase).toBe('delivered')
    expect(h.callbacks).toEqual([ended])
  } finally { await h.stop(); await h.close() }
})

test('refuses unknown, stale-attempt, non-paused requests without engine frames', async () => {
  const h = await fixture()
  try {
    const before = h.engine.journal.projection.sequence
    for (const [patch, code] of [[{ callbackId: 'missing' }, 'callback-unknown'],
      [{ expectedAttempt: 2 }, 'callback-attempt-conflict']] as const) {
      expect(await callAdmin(h.files, 'engine.callbackResolve', { ...h.target, ...patch }, limits))
        .toMatchObject({ status: 'ok', result: { status: 'rejected', code } })
    }
    expect(h.engine.journal.projection.sequence).toBe(before)
    await callAdmin(h.files, 'engine.callbackResolve', h.target, limits)
    const resumed = h.engine.journal.projection.sequence
    expect(await callAdmin(h.files, 'engine.callbackResolve', { ...h.target, action: 'abandon' }, limits))
      .toMatchObject({ status: 'ok', result: { status: 'rejected', code: 'callback-not-paused' } })
    expect(h.engine.journal.projection.sequence).toBe(resumed)
  } finally { await h.stop(); await h.close() }
})

test('a new parking frame invalidates an earlier resume replay before attempt checks', async () => {
  const h = await fixture()
  try {
    await callAdmin(h.files, 'engine.callbackResolve', h.target, limits)
    await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...h.delivery, attempt: 4 } })])
    const before = h.engine.journal.projection.sequence
    expect(await callAdmin(h.files, 'engine.callbackResolve', h.target, limits))
      .toMatchObject({ status: 'ok', result: { status: 'rejected', code: 'callback-attempt-conflict' } })
    expect(h.engine.journal.projection.sequence).toBe(before)
  } finally { await h.stop(); await h.close() }
})

test('resumes again at the same attempt after fifteen undriven minutes and precheck parking', async () => {
  const h = await fixture()
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000)
    await callAdmin(h.files, 'engine.callbackResolve', h.target, limits)
    vi.setSystemTime(1900000)
    await h.engine.drive(); await h.engine['outbox'].close()
    expect(h.engine.journal.projection.callbacks.get(h.payload.callbackId)).toMatchObject({ phase: 'paused', attempt: 3 })
    const before = h.engine.journal.projection.sequence
    expect(await callAdmin(h.files, 'engine.callbackResolve', h.target, limits))
      .toMatchObject({ status: 'ok', result: { status: 'ok', phase: 'retry-due', attempt: 3 } })
    expect(h.engine.journal.projection.sequence).toBe(before + 1)
  } finally { vi.useRealTimers(); await h.stop(); await h.close() }
})

test('non-paused refusal precedes an unmatched expected attempt', async () => {
  const h = await fixture()
  try {
    await callAdmin(h.files, 'engine.callbackResolve', h.target, limits)
    const before = h.engine.journal.projection.sequence
    expect(await callAdmin(h.files, 'engine.callbackResolve', { ...h.target, action: 'abandon', expectedAttempt: 1 }, limits))
      .toMatchObject({ status: 'ok', result: { status: 'rejected', code: 'callback-not-paused' } })
    expect(h.engine.journal.projection.sequence).toBe(before)
  } finally { await h.stop(); await h.close() }
})

test('reports callback resolution transport loss as an uncertain outcome', async () => {
  const h = await fixture()
  let stopped = false
  try {
    const endpoint = (await h.files.read('endpoint.json', 4096))!
    const credential = (await h.files.read('credential', 64))!
    await h.stop(); stopped = true
    await h.files.write('endpoint.json', endpoint); await h.files.write('credential', credential)
    expect(await callAdmin(h.files, 'engine.callbackResolve', h.target, limits))
      .toMatchObject({ status: 'uncertain', code: 'admin-outcome-unknown' })
  } finally { if (!stopped) await h.stop(); await h.close() }
})

test('bounds callback resolution JSON and rejects invented fields and response phases', () => {
  const input = { version: HOST_ADMIN_VERSION, requestId: 'request-a', nonce: 'nonce-a', processEpoch: 'epoch-a',
    method: 'engine.callbackResolve', params: { callbackId: 'callback-a', action: 'resume', expectedAttempt: 0 } }
  const request = decodeRequest(input)
  for (const patch of [{ callbackId: '' }, { action: 'deliver' }, { expectedAttempt: -1 }, { authority: 'local-operator' }]) {
    expect(() => decodeRequest({ ...input, params: { ...input.params, ...patch } })).toThrow()
  }
  expect(() => decodeResponse({ version: HOST_ADMIN_VERSION, requestId: 'request-a', method: input.method, status: 'ok',
    result: { status: 'ok', callbackId: 'callback-a', phase: 'committed', attempt: 0 } }, request)).toThrow()
})
