import { afterEach, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { inTimeWindow, reserveOpen } from '../src/admission.ts'
import { EngineProjection } from '../src/projection.ts'
import { auto, budget, definition, harness, nodeId, seat, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it('A15 uses half-open civil intervals including overnight weekdays', () => {
  const windows = [{ timeZone: 'UTC', start: '23:00', end: '01:00', weekdays: [4] }]
  expect(inTimeWindow(windows, Date.parse('2026-01-01T22:59Z'))).toBe(false)
  expect(inTimeWindow(windows, Date.parse('2026-01-01T23:00Z'))).toBe(true)
  expect(inTimeWindow(windows, Date.parse('2026-01-02T00:59Z'))).toBe(true)
  expect(inTimeWindow(windows, Date.parse('2026-01-02T01:00Z'))).toBe(false)
})
it('A15 preserves FIFO capacity and A16 waiters hold no exclusive tags', async () => {
  const h = await harness({ nodeEngineWindowLimit: 1 }); cleanups.push(h.close); await auto(h.engine)
  for (const name of ['seat-a', 'seat-b', 'seat-c'] as T.SeatName[]) {
    const def = definition(name)
    def.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: trigger().sourceId }, timeWindows: [], exclusiveTags: ['resource-a'] }]
    h.definitions.set(name, def)
    await h.engine.accept(trigger('external', name, name))
  }
  await h.engine.drive()
  expect(h.creates).toHaveLength(1)
  expect(h.engine.journal.projection.resources.size).toBe(1)
  expect((await h.engine.pending({ limit: 10 })).items.map(item => item.seat)).toEqual(['seat-b', 'seat-c'])
  h.state.owner = 'dead'
  const start = performance.now(); await h.engine.drive()
  expect(performance.now() - start).toBeLessThan(5000)
  expect(h.creates).toHaveLength(2)
  expect((await h.engine.pending({ limit: 10 })).items.map(item => item.seat)).toEqual(['seat-c'])
  expect([...h.engine.journal.projection.resources.values()].map(resource => resource.seat)).toEqual(['seat-b'])
})
it('A15 returns the fifth child ticket immediately and admits it after release', async () => {
  const h = await harness(); cleanups.push(h.close)
  const tickets: T.ChildAdmissionTicket[] = []
  for (let index = 0; index < 5; index++) {
    const ticket: T.ChildAdmissionTicket = { ticketId: `ticket-${index}` as T.ChildTicketId, parentSessionId: budget().sessionId,
      sequence: 0, requestDigest: 'digest-a' as T.SeatDigest, agentPreset: 'agent-a', permissionRevision: 1,
      phase: 'queued', childSessionId: null, ownerEpoch: 'epoch-a' as T.OwnerEpoch, stateVersion: 0 }
    tickets.push(ticket)
    expect((await h.engine.admitChild({ ticket, maxActive: 4 })).status).toBe(index < 4 ? 'admitted' : 'queued')
  }
  await h.engine.releaseChild(tickets[0]!.ticketId)
  expect((await h.engine.ticket(tickets[4]!.ticketId))?.phase).toBe('admitted')
})
it('A07 counts reservations and rejects established capacity without reserving partial labels', () => {
  const projection = new EngineProjection(), def = definition()
  projection.resources.set(budget().sessionId, { owner: { sessionId: budget().sessionId, intentId: 'intent-a' as T.OpenIntentId,
    ownerEpoch: 'epoch-a' as T.OwnerEpoch, resourceRevision: 1 }, nodeId, seat, exclusiveTags: ['resource-a'], engineWindowUnits: 1, seatWindowUnits: 1 })
  expect(reserveOpen({ projection, definition: def, nodeId, aliases: { local: nodeId }, engine: true, now: Date.now(), budget: budget(), sessionId: budget().sessionId })).toMatchObject({ status: 'pending', reason: 'seat-capacity' })
})
