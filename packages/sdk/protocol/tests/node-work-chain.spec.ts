import { describe, expect, it } from 'vitest'
import { decodeMessagesResult } from '../src/index.ts'
import { decodeSeatRequest, decodeSeatResult, decodeNodeWorkChainRequest, decodeNodeWorkChainResult,
  decodeNodeDelegationEvidenceRequest, decodeNodeDelegationEvidenceResult, encodeNodeWorkChainFrame } from '../src/seat.ts'

const cause = { domain: 'node-link', code: 'node-outcome-unknown', reason: 'Receipt unavailable',
  effectState: 'unknown', retryable: false, operationId: 'operation-a', nodeId: 'node-b', reasonCode: 'outcome-unknown' }
const error = { code: 'unavailable', message: 'Unavailable', alternative: 'Query original operation', retryable: false, effectState: 'unknown' }
const reference = { providerId: 'provider-a', reference: 'reference-a', revision: '1' }
const scopeReservation = { reservationId: 'reservation-a', sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'epoch-a',
  operationId: 'operation-a', taskIds: ['task-a'], snapshotDigest: 'digest-a', policyRevision: 1 }
const openingContext = { snapshot: { reference, text: 'Frozen input', digest: 'digest-a', revision: '1', taskIds: ['task-a'],
  scopeEvidence: [{ status: 'unknown', taskId: 'task-a', reason: 'Unspecified', alternative: 'serial' }] },
scopeReservation, openingMode: 'auto' }
const route = { sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'epoch-a', triggerId: null,
  originalOperationId: 'operation-a', targetNodeId: 'node-b', snapshotDigest: 'digest-a',
  callbackPath: { kind: 'opening-context', reference, operationId: 'operation-a' },
  modeCeiling: { mode: 'remind', policy: { sourceId: 'source-a', projectId: 'project-a', revision: 1 } } }
const frozen = { openingContext, route, expectedSeatRevision: 1 }
const callback = { kind: 'opened', callbackId: 'callback-a', sourceId: 'source-a', triggerId: null, stateVersion: 1,
  seat: 'seat-a', title: 'Window', sessionId: 'session-a', nodeId: 'node-b', nodeName: 'target', budget: {}, relatedTaskIds: ['task-a'] }
const key = { sourceNodeId: 'node-a', principalId: 'principal-a', sourceId: 'source-a', ownerEpoch: 'epoch-a', method: 'seat.openFrozen', operationId: 'operation-a' }

describe('node work chain projection', () => {
  it('projects exact revision observations without admitting them into business queries', () => {
    const request = { seat: 'seat-a', sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'epoch-a',
      openingMethod: 'seat.openFrozen', taskIds: [] }
    const result = { status: 'found', nodeId: 'node-b', seat: 'seat-a', revision: 1 }
    expect(decodeNodeWorkChainRequest('seat.definitionRevision', request)).toBe(request)
    expect(decodeNodeWorkChainResult('seat.definitionRevision', result)).toBe(result)
    for (const field of Object.keys(request)) {
      const missing = Object.fromEntries(Object.entries(request).filter(([key]) => key !== field))
      expect(() => decodeNodeWorkChainRequest('seat.definitionRevision', missing)).toThrow()
    }
    for (const patch of [{ seat: '*' }, { sourceId: '' }, { ownerEpoch: '' }, { sourceOwnerNodeId: '' },
      { openingMethod: 'seat.open' }, { taskIds: null }, { expectedSeatRevision: 1 }]) {
      expect(() => decodeNodeWorkChainRequest('seat.definitionRevision', { ...request, ...patch })).toThrow()
    }
    for (const revision of [0, -1, 1.5, true, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeNodeWorkChainResult('seat.definitionRevision', { ...result, revision })).toThrow()
    }
    expect(() => decodeNodeWorkChainResult('seat.definitionRevision', { ...result, definition: {} })).toThrow()
    expect(() => decodeNodeWorkChainRequest('chain.operation', { key: { ...key, method: 'seat.definitionRevision' }, payloadDigest: 'digest' })).toThrow()
    expect(() => decodeNodeWorkChainResult('chain.operation', { status: 'settled', method: 'seat.definitionRevision', result })).toThrow()
  })
  it('preserves legacy payload bytes without materializing optional fields', () => {
    const request = { seat: 'seat-a', operationId: 'operation-a', origin: 'manual' }
    const result = { status: 'rejected', error }
    const preview = { format: 'csv', sourcePath: 'seats.csv', columnMap: {}, defaults: {} }
    expect(JSON.stringify(decodeSeatRequest('seats/open', request))).toBe(JSON.stringify(request))
    expect(JSON.stringify(decodeSeatResult('seats/open', result))).toBe(JSON.stringify(result))
    expect(JSON.stringify(decodeSeatRequest('seats/import.preview', preview))).toBe(JSON.stringify(preview))
    const message = { messageId: 'message-a', operationId: 'operation-a', deliveryOutcome: 'rejected', messageState: 'rejected', pending: false, reason: 'unavailable', candidates: [] }
    expect(JSON.stringify(decodeMessagesResult('messages/send', message))).toBe(JSON.stringify(message))
    expect(decodeMessagesResult('messages/send', { ...message, cause })).toEqual({ ...message, cause })
  })
  it('retains original cause and rejects invalid codes and UTF-8 overlimits', () => {
    const result = { status: 'rejected', error: { ...error, cause } }
    expect(decodeSeatResult('seats/open', result)).toBe(result)
    for (const invalid of ['', 'a b', 'a'.repeat(129), 'é', 'a\n']) {
      expect(() => decodeSeatResult('seats/open', { ...result, error: { ...error, cause: { ...cause, code: invalid } } })).toThrow()
    }
    for (const invalid of ['a'.repeat(513), 'é'.repeat(257), 'line\nfeed', '', 'a\u0085']) {
      expect(() => decodeSeatResult('seats/open', { ...result, error: { ...error, cause: { ...cause, reason: invalid } } })).toThrow()
    }
    expect(() => decodeSeatResult('seats/open', { ...result, error: { ...error, cause: { ...cause, code: 'a'.repeat(128), reason: 'é'.repeat(256) } } })).not.toThrow()
    expect(() => decodeSeatResult('seats/open', { ...result, error: { ...error, cause: { ...cause, reasonCode: 'invented' } } })).toThrow()
  })
  it('requires nonempty unique explicit remote opening permission', () => {
    const remoteAdmission = { allowOpen: true, sourceNodeIds: ['node-a'], sourceIds: ['source-a'], principalIds: ['principal-a'], methods: ['seat.openFrozen'], policyRevision: 1 }
    const request = { format: 'csv', sourcePath: 'seats.csv', columnMap: {}, defaults: { remoteAdmission } }
    expect(decodeSeatRequest('seats/import.preview', request)).toBe(request)
    for (const patch of [{ allowOpen: false }, { sourceNodeIds: [] }, { sourceIds: ['*'] }, { principalIds: ['a', 'a'] }, { methods: ['seat.open'] }, { policyRevision: 0 }]) {
      expect(() => decodeSeatRequest('seats/import.preview', { ...request, defaults: { remoteAdmission: { ...remoteAdmission, ...patch } } })).toThrow()
    }
  })
  it('decodes seven methods and rejects malformed nested requests and results', () => {
    const cases = [
      ['engine.acceptFrozen', { ...frozen, envelope: { triggerId: 'trigger-a', sourceId: 'source-a', kind: 'external', evidence: { kind: 'external', eventType: 'ready' },
        seat: 'seat-a', projectId: 'project-a', receivedAt: 'now', dataDigest: 'digest-a', data: {}, callbackRef: 'source-a' } },
      { status: 'accepted', triggerId: 'trigger-a', queueItemId: 'queue-a', sequence: 1 }],
      ['seat.openFrozen', { ...frozen, request: { seat: 'seat-a', operationId: 'operation-a', origin: 'manual' } }, { status: 'cancelled' }],
      ['seat.wakeFrozen', { ...frozen, request: { seat: 'seat-a', operationId: 'operation-a' } }, { status: 'opened', result: { status: 'cancelled' } }],
      ['source.prepareOpening', { sourceId: 'source-a', sourceOwnerNodeId: 'node-a', ownerEpoch: 'epoch-a', reference, seat: 'seat-a', taskIds: ['task-a'], operationId: 'operation-a', targetNodeId: 'node-b', expectedSeatRevision: 1, openingMode: 'auto' }, { status: 'prepared', ...frozen }],
      ['source.checkAdmission', { scopeReservation, route, taskIds: ['task-a'], operationId: 'operation-a', executionNodeId: 'node-b' }, { status: 'unknown', policyRevision: null, error: { ...error, cause } }],
      ['source.deliverCallback', { callback, route, modelEvidence: { status: 'missing', sessionId: null, nodeId: 'node-b', observedAt: 'now' }, payloadDigest: 'digest-b' }, { status: 'committed', callbackId: 'callback-a', payloadDigest: 'digest-b' }],
      ['chain.operation', { key, payloadDigest: 'digest-b' }, { status: 'settled', method: 'seat.openFrozen', result: { status: 'cancelled' } }],
    ] as const
    for (const [method, request, result] of cases) {
      expect(decodeNodeWorkChainRequest(method, request)).toBe(request)
      expect(decodeNodeWorkChainResult(method, result)).toBe(result)
      expect(() => decodeNodeWorkChainRequest(method, { ...request, injected: true })).toThrow()
      expect(() => decodeNodeWorkChainResult(method, { status: 'invented' })).toThrow()
    }
    expect(() => decodeNodeWorkChainRequest('seat.openFrozen', { ...cases[1][1], openingContext: { ...openingContext, snapshot: {} } })).toThrow()
    expect(() => decodeNodeWorkChainResult('chain.operation', { status: 'settled', method: 'chain.operation', result: { status: 'missing' } })).toThrow()
  })
  it.each(['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const)('decodes pre-open rejected execution for %s without new result fields', (method) => {
    const result = { status: 'settled', method, result: { status: 'rejected', error: { ...error, code: 'gate-denied', effectState: 'none' } } }
    expect(decodeNodeWorkChainResult('chain.operation', result)).toBe(result)
    for (const field of ['revision', 'stateVersion', 'terminal']) {
      expect(() => decodeNodeWorkChainResult('chain.operation', { ...result, [field]: 4 })).toThrow()
    }
    expect(() => decodeNodeWorkChainResult('chain.operation', { ...result, method: 'seat.definitionRevision' })).toThrow()
    const rejectedCallback = { ...callback, kind: 'rejected', sessionId: null, reason: result.result.error }
    const request = { callback: rejectedCallback, route, modelEvidence: { status: 'missing', sessionId: null,
      nodeId: 'node-b', observedAt: 'now' }, payloadDigest: 'digest-a' }
    expect(decodeNodeWorkChainRequest('source.deliverCallback', request)).toBe(request)
    expect(() => decodeNodeWorkChainRequest('source.deliverCallback', { ...request,
      callback: { ...rejectedCallback, revision: 4 } })).toThrow()
  })
  it('preserves legacy authorization fact JSON bytes and accepts optional source identity', () => {
    const bytes = '{"authorizationId":"authorization-a","kind":"node-delegation","principalId":"principal-a","origin":"remote","nodeId":"node-b","taskIds":[],"operationId":"operation-a","policyRevision":1,"decision":"allowed","reasonCode":"allowed","requestDigest":"digest-a","checkedAt":"2026-01-01T00:00:00Z"}'
    const fact: unknown = JSON.parse(bytes)
    const request = { authorizationRef: 'authorization-a', method: 'seat.openFrozen', operationId: 'operation-a', payloadDigest: 'digest-a', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
    const retained = { status: 'retained', request, fact, expiresAt: '2026-01-01T00:01:00Z', revoked: false }
    const decoded = decodeNodeDelegationEvidenceResult(retained)
    expect(decoded.status).toBe('retained')
    if (decoded.status !== 'retained') throw new Error('Expected retained evidence')
    expect(encodeNodeWorkChainFrame(decoded.fact, [4096, 4096, 4096])).toBe(bytes)
    expect(decoded.fact).not.toHaveProperty('sourceNodeId')
    const current = { ...retained, fact: { ...decoded.fact, sourceNodeId: 'node-a' } }
    expect(decodeNodeDelegationEvidenceResult(current)).toBe(current)
    expect(JSON.stringify(decodeNodeDelegationEvidenceResult(current))).toBe(JSON.stringify(current))
    for (const sourceNodeId of ['', ' ', null, 3]) {
      expect(() => decodeNodeDelegationEvidenceResult({ ...retained, fact: { ...decoded.fact, sourceNodeId } })).toThrow('Invalid evidence result')
    }
  })
  it('validates evidence control fields and complete frame byte limits', () => {
    const request = { authorizationRef: 'authorization-a', method: 'seat.openFrozen', operationId: 'operation-a', payloadDigest: 'digest-a', sourceNodeId: 'node-a', targetNodeId: 'node-b' }
    expect(decodeNodeDelegationEvidenceRequest(request)).toBe(request)
    expect(() => decodeNodeDelegationEvidenceRequest({ ...request, method: 'arbitrary' })).toThrow()
    expect(decodeNodeDelegationEvidenceResult({ status: 'rejected', cause })).toEqual({ status: 'rejected', cause })
    expect(() => decodeNodeDelegationEvidenceResult({ status: 'retained', request, fact: {}, revoked: false, expiresAt: 'later' })).toThrow()
    const frame = { wrapper: 'é' }, size = new TextEncoder().encode(JSON.stringify(frame)).length
    expect(encodeNodeWorkChainFrame(frame, [size, size, size])).toBe(JSON.stringify(frame))
    expect(() => encodeNodeWorkChainFrame(frame, [size, size - 1, size])).toThrow()
    expect(() => encodeNodeWorkChainFrame(frame, [0, size, size])).toThrow()
    expect(() => encodeNodeWorkChainFrame('a'.repeat(1_048_576), [2_000_000, 2_000_000, 2_000_000])).toThrow()
  })
})
