/** Work-chain wire limits and identities remain independent of the legacy codec. */
import { expect, test } from 'vitest'
import { chainDigest, decodeChainCapability, decodeChainRequest, decodeChainResponse, decodeEvidenceFrame, encodeChainFrame } from '../src/chain-codec.ts'
import { chainFailure } from '../src/chain-identity.ts'

function frame() {
  const payload = { sourceId: 'source-a', sourceOwnerNodeId: 'node-b', ownerEpoch: 'owner-a',
    reference: { providerId: 'provider-a', reference: 'opening-a', revision: '1' }, seat: 'seat-a', taskIds: ['task-a'], operationId: 'operation-a',
    targetNodeId: 'node-a', expectedSeatRevision: 1, openingMode: 'prefill' }
  return { version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline: '2099-01-01T00:00:00.000Z', hop: 1, method: 'source.prepareOpening', payload,
    payloadDigest: chainDigest('source.prepareOpening', payload), delegation: { kind: 'node-delegation', hop: 1,
      principalId: 'principal-a', authorizationRef: 'grant-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
      operationId: 'operation-a', requestDigest: chainDigest('source.prepareOpening', payload), taskIds: ['task-a'],
      expiresAt: '2099-01-01T00:00:00.000Z' } }
}

test('decodes only frozen chain methods and binds delegation, operation and response identities', () => {
  const request = decodeChainRequest(frame())
  expect(request.method).toBe('source.prepareOpening')
  expect(() => decodeChainRequest({ ...frame(), method: 'source.arbitrary' })).toThrow()
  expect(() => decodeChainRequest({ ...frame(), hop: 2 })).toThrow()
  expect(() => decodeChainRequest({ ...frame(), payloadDigest: 'changed' })).toThrow()
  expect(() => decodeChainRequest({ ...frame(), delegation: { ...frame().delegation, targetNodeId: 'other' } })).toThrow()
  const response = chainFailure(request, 'cross-node-unsupported', 'peer-capability-missing')
  expect(decodeChainResponse(response, request)).toEqual(response)
  expect(() => decodeChainResponse({ ...response, requestId: 'other' }, request)).toThrow()
})

test('rejects invalid diagnostic codes rather than truncating them', () => {
  const request = decodeChainRequest(frame()), response = chainFailure(request, 'node-protocol-mismatch', 'invalid-diagnostic')
  if (response.status === 'ok') throw new Error('Expected refusal')
  for (const code of ['x'.repeat(129), 'unsafe code', 'bad\ncode']) {
    expect(() => decodeChainResponse({ ...response, error: { ...response.error,
      cause: { ...response.error.cause, code } } }, request)).toThrow()
  }
})

test('measures complete JSON wrappers and multibyte text at the negotiated minimum', () => {
  const value = { type: 'delegation-evidence', payload: 'é'.repeat(10) }
  const bytes = Buffer.byteLength(JSON.stringify(value))
  expect(encodeChainFrame(value, [bytes, bytes + 1, bytes + 2])).toBe(JSON.stringify(value))
  expect(() => encodeChainFrame(value, [bytes, bytes - 1, bytes + 2])).toThrow()
  expect(() => encodeChainFrame(value, [1, 1, 1])).toThrow()
  expect(() => encodeChainFrame(value, [bytes])).toThrow()
})

test('old peers omit capabilities and malformed method sets never become capabilities', () => {
  expect(decodeChainCapability(undefined)).toBeUndefined()
  const capability = { capability: 'node-work-chain/v1', maxFrameBytes: 1048576, methods: ['source.prepareOpening'] }
  expect(decodeChainCapability(capability)).toEqual(capability)
  expect(() => decodeChainCapability({ ...capability, methods: ['source.prepareOpening', 'source.prepareOpening'] })).toThrow()
  expect(() => decodeChainCapability({ ...capability, methods: ['source.arbitrary'] })).toThrow()
  expect(() => decodeChainCapability({ ...capability, maxFrameBytes: 1048577 })).toThrow()
})

test('evidence control frames have no recursively issued delegation or arbitrary fields', () => {
  const request = { authorizationRef: 'grant-a', method: 'source.prepareOpening', operationId: 'operation-a',
    payloadDigest: frame().payloadDigest, sourceNodeId: 'node-a', targetNodeId: 'node-b' }
  const evidence = { type: 'delegation-evidence', version: 'node-link/v1', requestId: 'evidence-a', request }
  expect(decodeEvidenceFrame(evidence)).toEqual(evidence)
  expect(() => decodeEvidenceFrame({ ...evidence, delegation: frame().delegation })).toThrow()
})
