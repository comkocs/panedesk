/** Three-generation ledger fixtures keep the tree and monitoring facts consistent with parent-child facts. */
import { describe, expect, it } from 'vitest'
import type {
  LedgerCall,
  LedgerEvent,
  LedgerInterval,
  LedgerLifecycle,
  LedgerRow,
  LedgerSnapshot,
} from '@panedesk/dsh-session-ledger'
import type { AssistantMessage } from '@panedesk/dsh-llm'
import type { SessionEvent, SessionId } from '@panedesk/dsh-session/types'
import { assembleSubagentTree, subagentTreeSessions } from '../src/tree.ts'
import { foldTranscriptFacts } from '../src/transcript.ts'

const startedAt = Date.parse('2026-10-31T04:00:00Z')
const asOf = startedAt + 60000

interface RowOptions {
  parentSessionId?: SessionId
  seat?: string
  taskId?: string
  usage?: NonNullable<LedgerCall['finish']>['usage']
  tiered?: boolean
  finish?: boolean
  endReason?: NonNullable<LedgerLifecycle['finish']>['endReason']
}

function callRow(sessionId: SessionId, runId: string, options: RowOptions = {}): LedgerCall {
  const context = {
    sessionId,
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    rootSessionId: 'session/root' as SessionId,
    seat: options.seat ?? 'seat-a',
    window: 'window-a',
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    nodeId: 'node-a' as LedgerCall['start']['nodeId'],
    identitySource: 'startup' as const,
    accountLabel: 'account-a',
  }
  return { kind: 'call', start: {
    ...context,
    callId: `call-${runId}` as LedgerCall['start']['callId'],
    runId: runId as LedgerCall['start']['runId'],
    logicalRequestId: `request-${runId}` as LedgerCall['start']['logicalRequestId'],
    attemptIndex: 0, attemptVisibility: 'physical' as const,
    provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'requested-a', purpose: 'conversation' as const,
    startedAt, cache: { cacheMode: 'explicit' as const, breakReasons: [] },
    cacheWriteTiering: options.tiered === false
      ? { kind: 'untiered' as const }
      : { kind: 'tiered' as const, short: '5m', long: '1h' },
    priceVersion: 'fixture-v1', priceKey: 'requested-a', referencePrice: true as const,
  }, ...(options.finish === false ? {} : { finish: {
    callId: `call-${runId}` as NonNullable<LedgerCall['finish']>['callId'],
    endedAt: startedAt + 1000, observedAt: startedAt + 1000,
    effectiveModel: 'effective-a', responseModelReported: 'same' as const, responseModel: 'effective-a',
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    usageState: options.usage === undefined ? 'missing' as const : 'complete' as const,
    pricingState: options.usage === undefined ? 'missing-usage' as const : 'priced' as const,
    wallMs: 1000, modelInFlightMs: 1000, queueMs: 0, backoffMs: 0, waits: [],
    compactionCount: 0, compactionTimes: [], endReason: 'completed' as const, recovered: false,
  } }) }
}

function runRow(sessionId: SessionId, runId: string, options: RowOptions = {}): LedgerLifecycle {
  const base = callRow(sessionId, runId, { ...options, finish: false })
  return { kind: 'run', start: { ...base.start, runId: runId as LedgerLifecycle['start']['runId'],
    launchState: 'started' as const, deliveryPaths: [] }, liveness: 'confirmed' as const,
  ...(options.finish === false ? {} : { finish: {
    runId: runId as NonNullable<LedgerLifecycle['finish']>['runId'],
    endedAt: startedAt + 2000, observedAt: startedAt + 2000,
    endReason: options.endReason ?? 'completed',
    deliveryState: 'present' as const, recovered: false,
  } }) }
}

function waitEvent(sessionId: SessionId, close: boolean, at: number): { kind: 'event'; event: LedgerEvent } {
  return { kind: 'event', event: {
    schemaVersion: 1 as const, eventId: `event-${sessionId}-${at}-${close ? 'close' : 'open'}` as LedgerEvent['eventId'],
    nodeId: 'node-a' as LedgerEvent['nodeId'], observedAt: at, runId: 'run-b' as LedgerEvent['runId'], sessionId,
    kind: close ? 'wait/end' as const : 'wait/start' as const,
    interval: { kind: 'queue' as const, startedAt: at, toolCallId: 'tool-1' as NonNullable<LedgerInterval['toolCallId']> },
  } }
}

function snapshot(rows: readonly LedgerRow[]): LedgerSnapshot {
  return { asOf, rows, complete: true, watermarks: { 'node-a': 'watermark-a' as LedgerSnapshot['watermarks'][string] } }
}

const ROOT = 'session/root' as SessionId
const CHILD = 'session/child' as SessionId
const GRANDCHILD = 'session/grandchild' as SessionId
const OUTSIDE = 'session/outside' as SessionId
const OTHER_ROOT = 'session/other-root' as SessionId

/** A finished root, a running child with tiered and untiered writes, a waiting grandchild, and one unrelated tree. */
function threeGenerations(): LedgerSnapshot {
  return snapshot([
    runRow(ROOT, 'run-root', { finish: true, endReason: 'completed', seat: 'seat-root', taskId: 'task-1' }),
    runRow(CHILD, 'run-child', { parentSessionId: ROOT, finish: false, seat: 'seat-child', taskId: 'task-1' }),
    callRow(CHILD, 'call-child-1', { parentSessionId: ROOT, seat: 'seat-child', taskId: 'task-1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10, cacheWriteLongTokens: 4 } }),
    callRow(CHILD, 'call-child-2', { parentSessionId: ROOT, seat: 'seat-child', taskId: 'task-1', tiered: false, usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 8 } }),
    callRow(CHILD, 'call-child-3', { parentSessionId: ROOT, seat: 'seat-child', taskId: 'task-1', finish: false }),
    runRow(GRANDCHILD, 'run-grandchild', { parentSessionId: CHILD, finish: false }),
    waitEvent(GRANDCHILD, false, startedAt + 3000),
    runRow(OUTSIDE, 'run-outside', { parentSessionId: OTHER_ROOT, finish: false }),
  ])
}

describe('subagent tree sessions', () => {
  it('keeps the three-generation membership consistent with ledger parent-child facts', () => {
    const facts = subagentTreeSessions(threeGenerations(), ROOT, asOf)
    expect(facts.map(fact => fact.sessionId)).toEqual([ROOT, CHILD, GRANDCHILD])
    expect(subagentTreeSessions(snapshot([]), ROOT, asOf).map(fact => fact.sessionId)).toEqual([ROOT])
    const tree = assembleSubagentTree(facts, new Map(), ROOT)
    expect(tree?.sessionId).toBe(ROOT)
    expect(tree?.parentSessionId).toBeNull()
    expect(tree?.children.map(child => child.sessionId)).toEqual([CHILD])
    expect(tree?.children[0]?.parentSessionId).toBe(ROOT)
    expect(tree?.children[0]?.children.map(child => child.sessionId)).toEqual([GRANDCHILD])
  })

  it('derives status from lifecycle finishes and unpaired wait facts', () => {
    const bySession = new Map(subagentTreeSessions(threeGenerations(), ROOT, asOf).map(fact => [fact.sessionId, fact]))
    expect(bySession.get(ROOT)).toMatchObject({ status: 'finished', endReason: 'completed' })
    expect(bySession.get(CHILD)).toMatchObject({ status: 'running' })
    expect(bySession.get(GRANDCHILD)).toMatchObject({ status: 'waiting' })
  })

  it('sums the five token columns without zero-filling unobserved values', () => {
    const bySession = new Map(subagentTreeSessions(threeGenerations(), ROOT, asOf).map(fact => [fact.sessionId, fact]))
    expect(bySession.get(CHILD)?.tokens).toEqual({
      inputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteShortTokens: 6,
      cacheWriteLongTokens: 4,
      cacheWriteTokens: 8,
      outputTokens: 10,
    })
    expect(bySession.get(CHILD)).toMatchObject({ usageState: 'partial' })
    expect(bySession.get(CHILD)?.cacheHitRate).toBeCloseTo(40 / 88)
    expect(bySession.get(GRANDCHILD)?.tokens).toEqual({
      inputTokens: null, cacheReadTokens: null, cacheWriteShortTokens: null,
      cacheWriteLongTokens: null, cacheWriteTokens: null, outputTokens: null,
    })
    expect(bySession.get(GRANDCHILD)).toMatchObject({ usageState: 'missing', cacheHitRate: null })
  })

  it('keeps untiered writes as one total without short or long columns', () => {
    const rows = snapshot([
      runRow(CHILD, 'run-child', { parentSessionId: ROOT, finish: false }),
      callRow(CHILD, 'call-untiered', { parentSessionId: ROOT, tiered: false, usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 7 } }),
    ])
    const child = subagentTreeSessions(rows, ROOT, asOf).find(fact => fact.sessionId === CHILD)
    expect(child?.tokens).toMatchObject({ cacheWriteShortTokens: null, cacheWriteLongTokens: null, cacheWriteTokens: 7 })
    expect(child?.cacheHitRate).toBe(0)
  })

  it('keeps elapsed time, seat, and task attribution on the node', () => {
    const bySession = new Map(subagentTreeSessions(threeGenerations(), ROOT, asOf).map(fact => [fact.sessionId, fact]))
    expect(bySession.get(CHILD)).toMatchObject({ elapsedMs: asOf - startedAt, seat: 'seat-child', taskId: 'task-1', runs: 1, calls: 3 })
    expect(bySession.get(ROOT)).toMatchObject({ elapsedMs: 2000, seat: 'seat-root', taskId: 'task-1' })
  })

  it('excludes sessions whose parent chain does not reach the root and survives parent cycles', () => {
    const cyclic = 'session/cyclic' as SessionId
    const rows = snapshot([
      runRow(CHILD, 'run-child', { parentSessionId: ROOT, finish: false }),
      runRow(cyclic, 'run-cyclic', { parentSessionId: cyclic, finish: false }),
      runRow(OUTSIDE, 'run-outside', { parentSessionId: OTHER_ROOT, finish: false }),
    ])
    expect(subagentTreeSessions(rows, ROOT, asOf).map(fact => fact.sessionId)).toEqual([ROOT, CHILD])
  })
})

describe('transcript folding', () => {
  function assistantEvent(model: string, seq: number): SessionEvent<'assistant/message'> {
    return { type: 'assistant/message', seq: seq as SessionEvent['seq'], time: startedAt + seq, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: `m-${seq}` as AssistantMessage['id'], role: 'assistant', content: [],
        source: { kind: 'model', provider: 'p', model } }, stream: [] } }
  }
  function toolCallEvent(name: string, seq: number, time: number): SessionEvent<'tool/call'> {
    return { type: 'tool/call', seq: seq as SessionEvent['seq'], time,
      data: { turn: 1, step: 1, callId: `c-${seq}` as SessionEvent<'tool/call'>['data']['callId'], name, arguments: '{}' } }
  }

  it('takes the model strictly from the session transcript, latest first', () => {
    const events = [assistantEvent('inherited-model', 1), assistantEvent('transcript-model', 2), toolCallEvent('fs_write', 3, startedAt + 30)]
    expect(foldTranscriptFacts(events, 1)).toEqual({
      model: 'transcript-model', modelSource: 'transcript',
      lastToolCall: { name: 'fs_write', time: startedAt + 30 },
    })
  })

  it('keeps an inherited-only log unknown instead of backfilling', () => {
    const events = [assistantEvent('ancestor-model', 1)]
    expect(foldTranscriptFacts(events, 1)).toEqual({ model: null, modelSource: 'transcript', lastToolCall: null })
  })
})
