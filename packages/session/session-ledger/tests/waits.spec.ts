import { describe, expect, it } from 'vitest'
import { foldLedger } from '../src/projection.ts'
import { projectWaits } from '../src/waits.ts'
import type { LedgerEvent, LedgerInterval } from '../src/types.ts'
import { callFinish, callStart, event } from './fixtures.ts'

const tool = (id: string) => id as NonNullable<LedgerInterval['toolCallId']>
function wait(id: string, interval: LedgerInterval, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const { callId: omitted, ...base } = event()
  void omitted
  return { ...base, eventId: id as LedgerEvent['eventId'], observedAt: interval.endedAt ?? interval.startedAt,
    kind: interval.endedAt === undefined ? 'wait/start' : 'wait/end', interval, ...overrides } as LedgerEvent
}
function fixture() {
  const finish = { ...event('call/end'), kind: 'call/end' as const,
    data: { ...callFinish, toolCallIds: [tool('sleep-a'), tool('child-a'), tool('marker-a')] } }
  const sleep = { kind: 'sleep' as const, toolCallId: tool('sleep-a'), startedAt: 300, endedAt: 30300, durationMs: 30000 }
  const child = { kind: 'subagent' as const, toolCallId: tool('child-a'), startedAt: 30300, endedAt: 50300, durationMs: 20000 }
  return { finish, sleep, child, events: [event('run/start'), event(), finish] }
}
const fold = (events: LedgerEvent[]) => foldLedger(events, { asOf: 60000, observationMaxAgeMs: 1000 })

describe('issuing call wait projection', () => {
  it('joins late sleep thirty seconds and child twenty seconds without rewriting terminal facts', () => {
    const { events, finish, sleep, child } = fixture()
    const before = JSON.stringify(events)
    expect(fold(events).rows.find(row => row.kind === 'call')?.waits).toEqual([])
    const open = wait('sleep-start', { kind: sleep.kind, toolCallId: sleep.toolCallId, startedAt: sleep.startedAt })
    const facts = [...events, open, wait('sleep-end', sleep), wait('sleep-copy', sleep), wait('child-end', child)]
    const snapshot = fold(facts)
    const call = snapshot.rows.find(row => row.kind === 'call')
    const run = snapshot.rows.find(row => row.kind === 'run')
    expect(call?.waits).toEqual([sleep, child])
    expect(call?.waitSummary).toEqual({ categories: {
      sleep: { toolCalls: 1, durationMs: 30000 }, subagent: { toolCalls: 1, durationMs: 20000 },
    } })
    expect(run?.waitSummary).toEqual(call?.waitSummary)
    expect(run?.unassignedWaits).toEqual([])
    expect(call?.finish).toEqual(finish.data)
    expect(call?.finish).toMatchObject({ wallMs: 100, modelInFlightMs: 100, endedAt: 200, waits: [] })
    expect(JSON.stringify(events)).toBe(before)
    expect(projectWaits(snapshot.rows)).toEqual(snapshot.rows)
    expect(fold([...facts].reverse())).toEqual(snapshot)
    const filtered = foldLedger(facts, { asOf: 60000, observationMaxAgeMs: 1000, filter: { from: 100, to: 201 } })
    expect(filtered.rows.find(row => row.kind === 'call')?.waitSummary).toEqual(call?.waitSummary)
  })

  it('keeps missing, mismatched and ambiguous identities unassigned rather than guessing', () => {
    const { events, sleep } = fixture()
    const other = { ...callStart, callId: 'call-b' as typeof callStart.callId }
    const duplicateOwner: LedgerEvent[] = [
      { ...event(), kind: 'call/start', eventId: 'call-b-start' as LedgerEvent['eventId'], callId: other.callId, data: other },
      { ...event('call/end'), kind: 'call/end', eventId: 'call-b-end' as LedgerEvent['eventId'], callId: other.callId,
        data: { ...callFinish, callId: other.callId, toolCallIds: [tool('sleep-a')] } },
    ]
    const unknown = { kind: 'subagent' as const, startedAt: 300, endedAt: 20300, durationMs: 20000 }
    const snapshot = fold([...events, ...duplicateOwner, wait('ambiguous', sleep), wait('missing-id', unknown),
      wait('unknown-id', { ...sleep, toolCallId: tool('unknown-a') }),
      wait('wrong-call', { ...sleep, toolCallId: tool('child-a') }, { callId: other.callId })])
    for (const row of snapshot.rows) if (row.kind === 'call') expect(row.waits).toEqual([])
    const run = snapshot.rows.find(row => row.kind === 'run')
    expect(run?.waitSummary).toEqual({ categories: {} })
    expect(run?.unassignedWaits).toHaveLength(4)
    expect(run?.unassignedWaitSummary?.categories.subagent).toEqual({ toolCalls: 0, durationMs: 20000 })
  })

  it.each(['nodeId', 'sessionId', 'runId'] as const)('does not cross %s boundaries for a reused tool identity', (field) => {
    const { events, sleep } = fixture()
    const snapshot = fold([...events, wait('other-scope', sleep, { [field]: 'other-a' })])
    expect(snapshot.rows.find(row => row.kind === 'call')?.waits).toEqual([])
    expect(snapshot.rows.find(row => row.kind === 'run')?.waits).toEqual([])
  })

  it('sums each call by category and preserves open waits without inventing seconds', () => {
    const { events, sleep } = fixture()
    const other = { ...callStart, callId: 'call-b' as typeof callStart.callId }
    const snapshot = fold([...events,
      { ...event(), kind: 'call/start', eventId: 'call-b-start' as LedgerEvent['eventId'], callId: other.callId, data: other },
      { ...event('call/end'), kind: 'call/end', eventId: 'call-b-end' as LedgerEvent['eventId'], callId: other.callId,
        data: { ...callFinish, callId: other.callId, toolCallIds: [tool('sleep-b')] } },
      wait('sleep-a', sleep), wait('sleep-b', { ...sleep, toolCallId: tool('sleep-b'), durationMs: 15000 }),
      wait('marker', { kind: 'external-marker', toolCallId: tool('marker-a'), startedAt: 300 }),
    ])
    expect(snapshot.rows.find(row => row.kind === 'run')?.waitSummary).toEqual({ categories: {
      sleep: { toolCalls: 2, durationMs: 45000 }, 'external-marker': { toolCalls: 1, durationMs: 0 },
    } })
    expect(snapshot.rows.find(row => row.kind === 'call')?.waits?.find(item => item.kind === 'external-marker'))
      .not.toHaveProperty('durationMs')
  })
})
