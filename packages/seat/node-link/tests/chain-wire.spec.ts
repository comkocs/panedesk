/** Work-chain wire limits and identities remain independent of the legacy codec. */
import { expect, test } from 'vitest'
import { chainDigest, decodeChainCapability, decodeChainRequest, decodeChainResponse, decodeEvidenceFrame, encodeChainFrame } from '../src/chain-codec.ts'
import { chainFailure } from '../src/chain-identity.ts'
import { helloAdvertisement, helloCapability } from '../src/chain-hello.ts'

test('negotiates exact revision reads outside the legacy seven-method advertisement', () => {
  const legacy = { capability: 'node-work-chain/v1' as const, maxFrameBytes: 1048576, methods: ['chain.operation' as const] }
  const extended = { ...legacy, methods: [...legacy.methods, 'seat.definitionRevision' as const] }
  expect(helloAdvertisement(legacy)).toEqual({ chain: legacy })
  const hello = helloAdvertisement(extended)
  expect(hello).toEqual({ chain: legacy, seatDefinitionRevision: 'seat-definition-revision/v1' })
  expect(helloCapability(hello)).toEqual(extended)
  expect(helloCapability({ chain: legacy })).toEqual(legacy)
  expect(() => decodeChainCapability(extended)).toThrow()
  expect(() => helloCapability({ chain: legacy, seatDefinitionRevision: 'future' })).toThrow()
})

test('binds exact revision observations to the paired node seat and tasks', () => {
  const original = frame(), method = 'seat.definitionRevision' as const
  const payload = { seat: 'seat-a', sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'owner-a',
    openingMethod: 'seat.openFrozen', taskIds: ['task-a'] }
  const make = (body = payload) => ({ ...original, method, payload: body, payloadDigest: chainDigest(method, body),
    delegation: { ...original.delegation, seat: body.seat, requestDigest: chainDigest(method, body) } })
  const request = decodeChainRequest(make())
  const response = { version: request.version, requestId: request.requestId, operationId: request.operationId,
    sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, method, status: 'ok',
    result: { status: 'found', nodeId: 'node-b', seat: 'seat-a', revision: 7 } }
  expect(decodeChainResponse(response, request)).toEqual(response)
  for (const patch of [{ nodeId: 'node-a' }, { seat: 'other' }, { revision: 0 }, { path: 'private' }]) {
    expect(() => decodeChainResponse({ ...response, result: { ...response.result, ...patch } }, request)).toThrow()
  }
  expect(() => decodeChainRequest(make({ ...payload, sourceOwnerNodeId: 'third-node' }))).toThrow()
  expect(() => decodeChainRequest(make({ ...payload, taskIds: [] }))).toThrow()
  expect(() => decodeChainRequest({ ...make(), delegation: { ...make().delegation, seat: 'other' } })).toThrow()
})

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

test('legacy strict decoding refuses source-wake configuration fields instead of treating them as wire authority', () => {
  const request = decodeChainRequest(frame())
  for (const name of ['wakeSource', 'sourceWake', 'frozenWakeContext']) {
    expect(() => decodeChainRequest({ ...frame(), [name]: true })).toThrow('Node chain frame rejected')
    const payload = { ...frame().payload, [name]: true }, payloadDigest = chainDigest(request.method, payload)
    expect(() => decodeChainRequest({ ...frame(), payload, payloadDigest,
      delegation: { ...frame().delegation, requestDigest: payloadDigest } })).toThrow()
  }
  expect(decodeChainRequest(JSON.parse(JSON.stringify(frame())))).toEqual(request)
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
