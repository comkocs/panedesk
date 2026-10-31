/** Optional source observations retain legacy replies and reject malformed wire fields. */
import { expect, test } from 'vitest'
import { decodeRequest, decodeResponse } from '../src/codec.ts'

const request = decodeRequest({ version: 'host-admin/v1', requestId: 'read-a', processEpoch: 'epoch-a',
  nonce: 'nonce-a', method: 'source.operations', params: {} })
const item = { key: 'key-a', state: 'awaiting-manual', eventId: 'event-a', target: 'node-a', since: '2026-01-01T00:00:00Z' }
const observation = { source: 'source-a', parkingCode: 'callback-desk-unreachable', firstAttemptAt: null,
  lastAttemptAt: '2026-01-01T00:00:00Z', count: 7, attemptsAtLeast: true, latestReason: 'callback-desk-unreachable' }
function response(value: object) {
  return { version: 'host-admin/v1', requestId: request.requestId, method: request.method, status: 'ok', result: { items: [value] } }
}
test('accepts old source rows and optional bounded observation evidence', () => {
  expect(decodeResponse(response(item), request)).toEqual(response(item))
  expect(decodeResponse(response({ ...item, observation }), request)).toEqual(response({ ...item, observation }))
})
test.each([{ count: -1 }, { count: 0.5 }, { attemptsAtLeast: 'yes' }, { firstAttemptAt: 'invalid' },
  { source: 'x'.repeat(513) }, { parkingCode: 'x'.repeat(513) }, { latestReason: 'x'.repeat(2001) }, { extra: true }])
('rejects malformed source observation %j', (invalid) => {
  expect(() => decodeResponse(response({ ...item, observation: { ...observation, ...invalid } }), request)).toThrow()
})
