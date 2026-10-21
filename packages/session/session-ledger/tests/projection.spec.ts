import { describe, expect, it } from 'vitest'
import { foldLedger, runningSessions } from '../src/projection.ts'
import type { LedgerEvent } from '../src/types.ts'
import { event, callStart } from './fixtures.ts'

const config = { asOf: 300, localNodeId: 'node-a', observationMaxAgeMs: 100 }
function observation(): LedgerEvent {
  return { ...event(), eventId: 'observation-a' as LedgerEvent['eventId'], kind: 'process/observed', observedAt: 250,
    identity: { nodeId: callStart.nodeId, pid: 123, startIdentity: 'start-a', verification: 'verified', registeredAt: 100 }, liveness: 'confirmed' }
}

describe('projection', () => {
  it('joins one call despite duplicate transport events and keeps unknown usage absent', () => {
    const snapshot = foldLedger([event('call/end'), event(), event()], config)
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]).toMatchObject({ kind: 'call', finish: { usageState: 'missing' } })
    expect(snapshot.rows[0]?.kind === 'call' && snapshot.rows[0].finish?.usage).toBeUndefined()
  })
  it('counts only fresh, verified, local, unfinished session identities', () => {
    const events = [event('run/start'), observation()]
    expect(runningSessions(foldLedger(events, config))).toBe(1)
    expect(runningSessions(foldLedger(events, { ...config, asOf: 1000 }))).toBe(0)
    expect(runningSessions(foldLedger(events, { ...config, localNodeId: 'node-b' }))).toBe(0)
    expect(runningSessions(foldLedger([event('run/start')], config))).toBe(0)
  })
  it('filters calls by start time across midnight and retains both model identities', () => {
    expect(foldLedger([event(), event('call/end')], { ...config, filter: { from: 100, to: 101, model: 'model-a', seat: 'seat-a' } }).rows).toHaveLength(1)
    expect(foldLedger([event(), event('call/end')], { ...config, filter: { from: 101 } }).rows).toHaveLength(0)
  })
  it('marks conflicting calls incomplete rather than choosing one terminal payload', () => {
    const end = event('call/end')
    const other = structuredClone(end)
    if (other.kind === 'call/end') other.data.endReason = 'error'
    const snapshot = foldLedger([event(), end, other], config)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.rows).toHaveLength(0)
  })
})
