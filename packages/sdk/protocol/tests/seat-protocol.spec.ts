import { describe, expect, it } from 'vitest'
import type { SeatDefinition } from '@panedesk/dsh-seat'
import { decodeSeatRequest, decodeSeatResult, isSeatMethod } from '../src/seat.ts'

describe('seat protocol extension', () => {
  it('preserves legacy cancellation bytes and bounds optional reasons without widening approval', () => {
    const request = { queueItemId: 'queue-a', expectedStateVersion: 1, operationId: 'cancel-a' }
    expect(JSON.stringify(decodeSeatRequest('seats/cancel', request))).toBe(JSON.stringify(request))
    const result = { status: 'cancelled', queueItemId: 'queue-a', stateVersion: 2 }
    expect(JSON.stringify(decodeSeatResult('seats/cancel', result))).toBe(JSON.stringify(result))
    for (const reason of ['', 'a'.repeat(512), 'é'.repeat(256)]) {
      expect(decodeSeatRequest('seats/cancel', { ...request, reason })).toEqual({ ...request, reason })
      expect(() => decodeSeatRequest('seats/approve', { ...request, reason })).toThrow()
    }
    for (const reason of ['a'.repeat(513), 'é'.repeat(257), '\n', String.fromCodePoint(0x85), null]) {
      expect(() => decodeSeatRequest('seats/cancel', { ...request, reason })).toThrow()
    }
    const cancellation = { authorizationId: 'auth-a', principalId: 'operator-a', kind: 'local-operator',
      operationId: 'cancel-a', queueItemId: 'queue-a', cancelledAt: '2026-01-01T00:00:00Z', stateVersion: 2,
      reasonPresent: true, reason: 'Stopped' }
    const settled = { status: 'settled', result: { status: 'cancelled', cancellation } }
    expect(decodeSeatResult('seats/operation', settled)).toEqual(settled)
    for (const patch of [{ kind: 'invented' }, { reason: '\n' }, { cancelledAt: 'invalid' }, { authorizationId: '' }]) {
      expect(() => decodeSeatResult('seats/operation', { ...settled, result: { status: 'cancelled', cancellation: { ...cancellation, ...patch } } })).toThrow()
    }
  })
  it('keeps known seat methods additive and rejects inherited names', () => {
    expect(isSeatMethod('seats/open')).toBe(true)
    expect(isSeatMethod('toString')).toBe(false)
    expect(isSeatMethod('session/prompt')).toBe(false)
  })
  it.each(['all', '*', String.fromCodePoint(0x5168, 0x90e8), 'seat-?'])('rejects implicit batch target %s before dispatch', (seat) => {
    expect(() => decodeSeatRequest('seats/openBatch', { seats: [seat], origin: 'remote', operationId: 'operation-a' })).toThrow()
  })
  it('rejects empty and duplicate batches and caller-supplied authority', () => {
    for (const seats of [[], ['seat-a', 'seat-a']]) expect(() => decodeSeatRequest('seats/openBatch', { seats, origin: 'remote', operationId: 'operation-a' })).toThrow()
    expect(() => decodeSeatRequest('seats/open', { seat: 'seat-a', origin: 'remote', operationId: 'operation-a', principalId: 'owner' })).toThrow()
    expect(decodeSeatRequest('seats/openBatch', { seats: ['seat-a', 'seat-b', 'seat-c'], origin: 'remote', operationId: 'operation-a' }))
      .toEqual({ seats: ['seat-a', 'seat-b', 'seat-c'], origin: 'remote', operationId: 'operation-a' })
  })
  it('validates every management request and nested response before projection', () => {
    const wait = { waitId: 'wait-a', sessionId: 'session-a', mode: 'all', objects: [{ kind: 'job', id: 'job-a' }], observations: [],
      phase: 'registered', operationId: 'operation-a', wakeOperationId: 'wake-a', stateVersion: 1, durability: 'durable' }
    const report = { reportId: 'report-a', sessionId: 'session-a', canClose: false, waitingFor: [{ kind: 'job', objectId: 'job-a', summary: 'Pending' }],
      nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, submittedAt: '2026-01-01T00:00:00Z', stateVersion: 1 }
    const cases = [
      ['seats/import.preview', { format: 'csv', sourcePath: 'seats.csv', columnMap: { seat: 'Name' }, defaults: {} },
        { planId: 'plan-a', sourceFileHash: 'digest-a', mappingHash: 'digest-b', baseRevision: 0, rows: [] }],
      ['seats/import.commit', { planId: 'plan-a', selectedRows: [1], expectedRevision: 0, operationId: 'operation-a' }, { status: 'committed', revision: 1, rows: [] }],
      ['seats/setAuthority', { authority: 'seat-store', authorizationRef: 'authorization-a', expectedRevision: 1, operationId: 'operation-a' }, { status: 'saved', revision: 2 }],
      ['seats/report.submit', { report, operationId: 'operation-a' }, { status: 'recorded', reportId: 'report-a', stateVersion: 1 }],
      ['seats/wait.register', { waitId: 'wait-a', sessionId: 'session-a', mode: 'all', objects: wait.objects, operationId: 'operation-a' }, { status: 'registered', wait }],
      ['seats/wait.cancel', { waitId: 'wait-a', sessionId: 'session-a', expectedStateVersion: 1, operationId: 'operation-b' }, { status: 'cancelled', wait: { ...wait, phase: 'cancelled' } }],
    ] as const
    for (const [method, request, result] of cases) {
      expect(isSeatMethod(method)).toBe(true)
      expect(decodeSeatRequest(method, request)).toEqual(request)
      expect(decodeSeatResult(method, result)).toEqual(result)
      expect(() => decodeSeatRequest(method, { ...request, principalId: 'owner' })).toThrow()
      expect(() => decodeSeatResult(method, {})).toThrow()
    }
    expect(() => decodeSeatRequest('seats/report.submit', { report: { ...report, canClose: 'yes' }, operationId: 'operation-a' })).toThrow()
    expect(() => decodeSeatResult('seats/wait.register', { status: 'registered', wait: { ...wait, observations: [{ outcome: 'completed' }] } })).toThrow()
    expect(() => decodeSeatResult('seats/import.commit', { status: 'committed', revision: 1, rows: [{ row: 1 }] })).toThrow()
  })
  it.each([true, false, undefined])('accepts autoKeepAlive=%s in import defaults and definitions', (autoKeepAlive) => {
    const definition = {
      schemaVersion: 1, revision: 1, seat: 'seat-a' as SeatDefinition['seat'], platform: 'server', node: 'node-a',
      projectId: 'project-a' as SeatDefinition['projectId'], directories: [{ path: '/workspace', startup: true }],
      memoryDirectories: [], opening: { kind: 'text', text: 'Start' }, openingInstructionFiles: [],
      agentPreset: 'default', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', permissionPreset: 'default',
      subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 1, subagentContextThresholdTokens: 1000,
      rules: [], worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 24 },
      ...(autoKeepAlive === undefined ? {} : { autoKeepAlive }),
    } satisfies SeatDefinition
    const request = { format: 'csv', sourcePath: 'seats.csv', columnMap: { Name: 'seat' }, defaults: definition }
    const row = { row: 1, seat: definition.seat, definition, rowHash: 'digest-a', columnHashes: {},
      action: 'create', selected: true, differences: [], diagnostics: [] }
    const results = [
      ['seats/import.preview', { planId: 'plan-a', sourceFileHash: 'digest-a', mappingHash: 'digest-b', baseRevision: 0, rows: [row] }],
      ['seats/import.commit', { status: 'committed', revision: 1, rows: [row] }],
    ] as const
    expect(decodeSeatRequest('seats/import.preview', request)).toEqual(request)
    for (const [method, result] of results) {
      expect(decodeSeatResult(method, result)).toEqual(result)
      expect(() => decodeSeatResult(method, { ...result, rows: [{ ...row, definition: { ...definition, unknownField: true } }] })).toThrow()
    }
    expect(() => decodeSeatRequest('seats/import.preview', { ...request, defaults: { ...definition, unknownField: true } })).toThrow()
    for (const invalid of ['false', 0, null, {}, []]) {
      const malformed = { ...definition, autoKeepAlive: invalid }
      expect(() => decodeSeatRequest('seats/import.preview', { ...request, defaults: malformed })).toThrow()
      for (const [method, result] of results) {
        expect(() => decodeSeatResult(method, { ...result, rows: [{ ...row, definition: malformed }] })).toThrow()
      }
    }
  })
  it('rejects malformed nested evidence across every window and engine result family', () => {
    const opened = { status: 'opened', sessionId: 'session-a', seat: 'seat-a', nodeId: 'node-a', nodeName: 'node-a', title: '',
      budget: { windowBudgetUsd: '1000' }, phase: 'active', stateVersion: 1, callbackIds: ['callback-a'] }
    expect(decodeSeatResult('seats/open', opened)).toEqual(opened)
    expect(() => decodeSeatResult('seats/open', { ...opened, budget: { windowBudgetUsd: 1000 } })).toThrow()
    expect(() => decodeSeatResult('seats/open', { ...opened, callbackIds: [1] })).toThrow()
    expect(() => decodeSeatResult('seats/list', { status: 'listed', sessions: [{}], unopenedSeats: [], snapshotAt: '2026-01-01T00:00:00Z', complete: true })).toThrow()
    expect(() => decodeSeatResult('seats/binding', { kind: 'seat', sessionId: 'session-a', nodeId: 'node-a' })).toThrow()
    expect(() => decodeSeatResult('seats/renew', { status: 'renewed', sessionId: 'session-a', cacheEvidence: {} })).toThrow()
    expect(() => decodeSeatResult('seats/close', { status: 'busy', sessionId: 'session-a', busyReasons: [{ kind: 'unknown' }] })).toThrow()
    expect(() => decodeSeatResult('seats/replace', { status: 'replacing', replacementId: 'replacement-a', oldSessionId: 'session-a', newSessionId: 'session-b', phase: 'opening', permit: {} })).toThrow()
    expect(() => decodeSeatResult('seats/rename', { status: 'renamed', sessionId: 'session-a', title: { title: 'Window' } })).toThrow()
    expect(() => decodeSeatResult('seats/wake', { status: 'opened', result: { ...opened, phase: 'invented' } })).toThrow()
    expect(() => decodeSeatResult('seats/operation', { status: 'settled', result: { status: 'renewed' } })).toThrow()
    expect(() => decodeSeatResult('seats/setProjectMode', { status: 'saved', policy: { projectId: 'project-a', mode: 'auto', revision: 1 } })).toThrow()
    expect(() => decodeSeatResult('seats/pending', { items: [{}], complete: true, watermark: 1 })).toThrow()
    expect(() => decodeSeatResult('seats/gates', { gates: [{}], complete: true, watermark: 1 })).toThrow()
    expect(() => decodeSeatResult('seats/nodeStatus', { nodeId: 'node-a', nodeName: 'node-a', engine: 'running', openEngineWindows: 0, limit: null })).toThrow()
  })
  it('preserves queued outcomes and rejects malformed or unknown results', () => {
    const queued = { status: 'queued', queueItemId: 'queue-a', sequence: 1, reason: 'seat-capacity', blockedBy: ['seat-a'] }
    expect(decodeSeatResult('seats/open', queued)).toEqual(queued)
    expect(() => decodeSeatResult('seats/open', { status: 'invented' })).toThrow()
    expect(() => decodeSeatResult('seats/open', { status: 'opened' })).toThrow()
    expect(() => decodeSeatResult('seats/open', { status: 'rejected', error: { code: 'invented' } })).toThrow()
    expect(decodeSeatResult('seats/binding', null)).toBeNull()
  })
})
