/** Query wire validation rejects malformed effects before returning them to an operator. */
import { expect, test } from 'vitest'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { HOST_ADMIN_VERSION } from '../src/index.ts'
import { digest } from '@panedesk/dsh-seat-engine'

const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'query-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'engine.query', params: { nodeId: 'node-a', limit: 4 } })
function response(effect: unknown) {
  return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method, status: 'ok',
    result: { effects: [effect], complete: true, watermark: 1 } }
}
const effect = { eventId: 'event-a', kind: 'git/checkpoint',
  data: { repositoryId: 'repo-a', ref: 'refs/heads/main', objectId: null, sequence: 1 } }

test('reads callback diagnostics by task and seat without widening bounded query pages', () => {
  const callbackQuery = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'callback-query', processEpoch: 'epoch-a',
    nonce: 'nonce-a', method: 'engine.query', params: { nodeId: 'node-a', seat: 'seat-a', taskId: 'task-a',
      kinds: ['callback/attempted', 'callback/delivered'], limit: 1 } })
  const payload = { kind: 'opened', callbackId: 'callback-a', sourceId: 'source-a', triggerId: null, stateVersion: 1,
    seat: 'seat-a', title: 'Window', sessionId: 'session-a', nodeId: 'node-a', nodeName: 'node-a', budget: {}, relatedTaskIds: ['task-a'] }
  const lastDiagnostic = { stage: 'local-query', cause: { domain: 'seat-callback', code: 'unavailable', reason: 'Owner is unavailable',
    operationId: 'operation-a', nodeId: 'node-a', effectState: 'none', retryable: true, reasonCode: 'hello-policy-not-ready' } }
  const callback = { eventId: 'event-callback', kind: 'callback/attempted', data: { payload, payloadDigest: digest(payload),
    attempt: 2, phase: 'retry-due', nextDue: '2026-01-01T00:00:00Z', responseClass: 'transient', lastDiagnostic } }
  const reply = { version: HOST_ADMIN_VERSION, requestId: callbackQuery.requestId, method: callbackQuery.method, status: 'ok',
    result: { effects: [callback], complete: false, watermark: 2, nextCursor: { nodeId: 'node-a', sequence: 1, effectIndex: 0 } } }
  expect(decodeResponse(reply, callbackQuery)).toEqual(reply)
  expect(() => decodeResponse({ ...reply, result: { ...reply.result, effects: [callback, callback] } }, callbackQuery)).toThrow()
  expect(() => decodeResponse({ ...reply, result: { ...reply.result, effects: [{ ...callback,
    data: { ...callback.data, lastDiagnostic: { ...lastDiagnostic, stage: 'unknown' } } }] } }, callbackQuery)).toThrow()
})

test('accepts an engine-validated effect and rejects unknown kinds, malformed payloads and cursor bounds', () => {
  expect(decodeResponse(response(effect), request)).toMatchObject({ status: 'ok' })
  for (const invalid of [{ ...effect, kind: 'unknown' }, { ...effect, eventId: '' },
    { ...effect, data: {} }, { ...effect, data: { ...effect.data, ref: 'main' } },
    { ...effect, sessionId: 7 }]) expect(() => decodeResponse(response(invalid), request)).toThrow()
  const valid = response(effect)
  expect(() => decodeResponse({ ...valid, result: { ...valid.result, watermark: -1 } }, request)).toThrow()
  expect(() => decodeResponse({ ...valid, result: { ...valid.result,
    nextCursor: { nodeId: 'node-b', sequence: 1, effectIndex: 0 } } }, request)).toThrow()
  expect(() => decodeResponse({ ...valid, result: { ...valid.result,
    nextCursor: { nodeId: 'node-a', sequence: 2, effectIndex: 0 } } }, request)).toThrow()
})
