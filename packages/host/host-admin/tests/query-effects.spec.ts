/** Query wire validation rejects malformed effects before returning them to an operator. */
import { expect, test } from 'vitest'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { HOST_ADMIN_VERSION } from '../src/index.ts'

const request = decodeRequest({ version: HOST_ADMIN_VERSION, requestId: 'query-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'engine.query', params: { nodeId: 'node-a', limit: 4 } })
function response(effect: unknown) {
  return { version: HOST_ADMIN_VERSION, requestId: request.requestId, method: request.method, status: 'ok',
    result: { effects: [effect], complete: true, watermark: 1 } }
}
const effect = { eventId: 'event-a', kind: 'git/checkpoint',
  data: { repositoryId: 'repo-a', ref: 'refs/heads/main', objectId: null, sequence: 1 } }

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
