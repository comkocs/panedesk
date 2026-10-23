/** Public declaration tables stay exhaustive without implementing the engine. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  SEAT_ENGINE_EVENT_NAMES, SEAT_ENGINE_NAMESPACE, SEAT_ENGINE_SCHEMA_VERSION,
  SEAT_ERROR_CODES, SEAT_GATE_HOOKS,
} from '../src/index.ts'
import type {
  EngineEffect, EngineEventKind, GateContext, GateHook, GateResult, OpenSeatResult,
  ReplaceSeatResult, ResourceReleaseReason, SeatCallbackPayload, SeatErrorCode,
} from '../src/index.ts'

const errorCodes = [
  'seat-not-found', 'seat-already-open', 'seat-choice-required',
  'cross-node-unsupported', 'import-preview-stale', 'import-conflict',
  'import-source-authoritative', 'seat-store-authoritative',
  'invalid-definition', 'invalid-request', 'unsupported-schema-version',
  'revision-conflict', 'operation-id-conflict', 'event-id-conflict',
  'unauthorized', 'unavailable', 'disabled', 'engine-store-corrupt',
  'session-not-found', 'session-busy', 'state-conflict', 'owner-unknown',
  'memory-seat-mismatch', 'wake-template-missing', 'batch-explicit-seats-required',
  'batch-limit-exceeded', 'cache-evidence-unavailable', 'cache-expired',
  'cache-prefix-changed', 'maintenance-busy', 'renewal-uncertain',
  'subagent-renewal-expired', 'subagent-context-limit', 'evidence-unavailable',
  'polling', 'sleep-limit-exceeded', 'gate-denied', 'audit-unavailable',
  'checkpoint-unavailable', 'checkpoint-changed', 'checkpoint-budget-exceeded',
  'budget-unverifiable', 'budget-full', 'budget-stopped',
  'source-not-found', 'source-authentication-failed', 'source-payload-too-large',
  'source-timestamp-invalid', 'callback-authentication-failed', 'callback-protocol-error',
  'open-create-failed', 'open-configuration-failed', 'opening-failed',
  'session-id-conflict', 'replacement-open-failed', 'replacement-first-turn-failed',
  'replacement-cleanup-failed', 'wait-id-conflict', 'wait-object-not-found',
  'wait-object-unauthorized', 'ticket-not-found', 'ticket-cancelled',
  'report-not-found', 'report-revoked', 'causal-depth-exceeded',
  'rule-self-loop', 'query-cursor-invalid', 'export-event-conflict',
  'worktree-client-limit', 'worktree-unverified',
] as const satisfies readonly SeatErrorCode[]

const eventNames = [
  'trigger/accepted', 'trigger/deduplicated', 'trigger/coalesced',
  'queue/pending', 'queue/approved', 'queue/cancelled', 'open/intent',
  'open/created', 'open/configured', 'open/opening-failed', 'open/rejected',
  'source/rejected', 'seat/binding', 'window/closing', 'window/closed',
  'window/replacement', 'callback/pending', 'callback/attempted', 'callback/delivered',
  'gate/hit', 'gate/expired', 'budget/warning', 'budget/stopped', 'budget/reconfigured',
  'wait/registered', 'wait/satisfied', 'wait/woken', 'wait/cancelled',
  'child/queued', 'child/admitted', 'child/released', 'job/observed',
  'resource/reserved', 'resource/released', 'mode/changed', 'memory/audit',
  'report/submitted', 'report/revoked',
  'cache/keepalive', 'cache/keepalive-skipped', 'git/checkpoint',
] as const satisfies readonly EngineEventKind[]

function isRejected(result: OpenSeatResult): result is Extract<OpenSeatResult, { status: 'rejected' }> {
  return result.status === 'rejected'
}
function isReplacementQueued(result: ReplaceSeatResult): result is Extract<ReplaceSeatResult, { status: 'queued' }> {
  return result.status === 'queued'
}
function isReplacementFailure(payload: SeatCallbackPayload): payload is Extract<SeatCallbackPayload, { kind: 'replacement-failed' }> {
  return payload.kind === 'replacement-failed'
}
function isRelease(effect: EngineEffect): effect is Extract<EngineEffect, { kind: 'resource/released' }> {
  return effect.kind === 'resource/released'
}

describe('seat declarations', () => {
  it('pins every machine error code including the shared cross-node refusal', () => {
    expect(Object.keys(SEAT_ERROR_CODES).sort()).toEqual([...errorCodes].sort())
    expect(new Set(errorCodes).size).toBe(errorCodes.length)
    expectTypeOf<keyof typeof SEAT_ERROR_CODES>().toEqualTypeOf<SeatErrorCode>()
    expectTypeOf<typeof errorCodes[number]>().toEqualTypeOf<SeatErrorCode>()
    expect(SEAT_ERROR_CODES['cross-node-unsupported']).toBe(true)
  })

  it('pins seven semantic hooks without registering upstream events', () => {
    expect(SEAT_GATE_HOOKS).toEqual([
      'before-open', 'before-batch-open', 'before-memory-write', 'before-tool-call',
      'before-subagent-dispatch', 'after-subagent-return', 'after-compaction',
    ])
    expectTypeOf<GateContext['hook']>().toEqualTypeOf<GateHook>()
    expectTypeOf<GateResult['outcome']>().toEqualTypeOf<'allow' | 'deny' | 'observe'>()
  })

  it('pins the independent version-one event names and exhaustive payload map', () => {
    expect(SEAT_ENGINE_NAMESPACE).toBe('ledger/engine/v1')
    expect(SEAT_ENGINE_SCHEMA_VERSION).toBe(1)
    expect(Object.keys(SEAT_ENGINE_EVENT_NAMES).sort()).toEqual([...eventNames].sort())
    expectTypeOf<typeof eventNames[number]>().toEqualTypeOf<EngineEventKind>()
    expectTypeOf<EngineEffect['kind']>().toEqualTypeOf<EngineEventKind>()
  })

  it('narrows actionable open failures without accepting successful outcomes', () => {
    const rejected: OpenSeatResult = {
      status: 'rejected',
      error: { code: 'seat-not-found', message: 'No definition for seat seat-a.', alternative: 'Define seat-a before opening it.', retryable: false, effectState: 'none' },
    }
    expect(isRejected(rejected)).toBe(true)
    expect(isRejected({ status: 'cancelled' })).toBe(false)
    if (isRejected(rejected)) expectTypeOf(rejected.error.code).toEqualTypeOf<SeatErrorCode>()
  })

  it('keeps replacement queueing and failed-new cleanup visible to consumers', () => {
    expectTypeOf(isReplacementQueued).returns.toEqualTypeOf<boolean>()
    expectTypeOf<Extract<ReplaceSeatResult, { status: 'queued' }>['phase']>().toEqualTypeOf<'queued'>()
    expectTypeOf(isReplacementFailure).returns.toEqualTypeOf<boolean>()
    expectTypeOf<Extract<SeatCallbackPayload, { kind: 'replacement-failed' }>['cleanup']>().toEqualTypeOf<'not-created' | 'closed' | 'pending'>()
  })

  it('distinguishes holder-death release from host-recovery release', () => {
    expectTypeOf(isRelease).returns.toEqualTypeOf<boolean>()
    expectTypeOf<Extract<EngineEffect, { kind: 'resource/released' }>['data']['reason']>().toEqualTypeOf<ResourceReleaseReason>()
    const reasons: readonly ResourceReleaseReason[] = ['holder-death', 'host-restart-recovery']
    expect(new Set(reasons).size).toBe(2)
  })
})
