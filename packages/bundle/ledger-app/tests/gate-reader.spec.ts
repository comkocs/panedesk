import { Context } from '@panedesk/cordis'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import * as EngineReader from '@panedesk/dsh-seat-engine/reader'
import * as GateReader from '@panedesk/dsh-seat-gates/reader'
import type { EngineEffect, SeatEngineQueryService } from '@panedesk/dsh-seat'
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { definition, engineConfig, hit, inventory, nodeId } from './gate-reader-fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const home = await mkdtemp(join(import.meta.dirname, '.gate-reader-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const writer = new Context(), reader = new Context()
  cleanups.push(() => writer.fiber.dispose(), () => reader.fiber.dispose())
  const engine = new SeatEngine(writer, { home, nodeId, config: engineConfig }, { seats: () => undefined, ledger: () => undefined })
  cleanups.push(() => engine.shutdown())
  await engine.ready()
  await reader.plugin(EngineReader, { home, nodeId, maxDecisionBytes: engineConfig.maxDecisionBytes })
  const fiber = reader.plugin(GateReader)
  await fiber
  await vi.waitFor(() => { expect(reader.get('seatGatesQuery')).toBeDefined() })
  const gates = reader.get('seatGatesQuery')!
  async function commit(effects: EngineEffect[]) {
    const sequence = engine.journal.projection.sequence
    const result = await engine.appendEffects({ decisionId: `decision-${sequence}` as never, expectedSequence: sequence,
      observedAt: '2026-01-01T00:00:00Z', policyRevision: 1, effects })
    expect(result.status).toBe('committed')
  }
  return { home, engine, reader, gates, fiber, commit }
}

it('rebuilds gate revisions, expiry and recorded limits without locks, writes or drivers', async () => {
  const h = await setup()
  const expired = { ...definition, revision: 2, expiresAt: '2000-01-01T00:00:00Z' }
  await h.commit([hit(1), hit(2), hit(1, expired), { eventId: 'expired-a' as never, kind: 'gate/expired',
    data: { definition: expired, hitCount: 3, expiredAt: '2000-01-01T00:00:00Z' } }])
  await h.engine.shutdown()
  const before = await inventory(h.home)
  const result = await h.gates.list({ limit: 1 })
  expect(result).toMatchObject({ complete: false, watermark: 1, gates: [{ hitCount: 2, expired: false,
    limit: { status: 'reached', value: 2, observed: 2 } }] })
  if ('status' in result || !result.nextCursor) throw new Error('Expected a gate page cursor')
  expect(await h.gates.list({ limit: 1, cursor: result.nextCursor })).toMatchObject({ complete: true,
    gates: [{ definition: { revision: 2 }, hitCount: 3, expired: true, limit: { status: 'below' } }] })
  expect(await h.gates.list({ gateId: 'absent', limit: 5 })).toMatchObject({ gates: [], complete: true })
  expect(await h.gates.list({ hook: 'after-compaction', limit: 5 })).toMatchObject({ gates: [] })
  expect(await h.gates.list({ limit: 0 })).toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
  expect(await inventory(h.home)).toEqual(before)
  expect(h.reader.get('seatEngine')).toBeUndefined()
  expect(h.reader.get('seatGates')).toBeUndefined()
  await h.fiber.dispose()
  expect(h.reader.get('seatGatesQuery')).toBeUndefined()
})

it('reads concurrently with a live engine writer and rejects stale snapshot cursors', async () => {
  const h = await setup()
  await h.commit([hit(1), hit(1, { ...definition, revision: 2 })])
  const first = await h.gates.list({ limit: 1 })
  if ('status' in first || !first.nextCursor) throw new Error('Expected a gate page cursor')
  for (let count = 2; count <= 5; count++) {
    const [read] = await Promise.all([h.gates.list({ limit: 10 }), h.commit([hit(count)])])
    expect(read).not.toHaveProperty('status', 'rejected')
    const before = await inventory(h.home)
    expect(await h.gates.list({ limit: 10 })).toMatchObject({ gates: [{ hitCount: count }, { hitCount: 1 }] })
    expect(await inventory(h.home)).toEqual(before)
  }
  expect(await h.gates.list({ limit: 1, cursor: first.nextCursor })).toMatchObject({ status: 'rejected', error: { code: 'query-cursor-invalid' } })
})

it('preserves incomplete tails and reports unknown unrecorded limit evidence', async () => {
  const h = await setup()
  await h.commit([hit(1, { ...definition, criterion: { type: 'polling' as never, parameters: {} } })])
  await h.engine.shutdown()
  const events = join(h.engine.journal.root, 'events'), file = (await readdir(events))[0]!
  await appendFile(join(events, file), '{')
  const before = await inventory(h.home)
  expect(await h.gates.list({ limit: 10 })).toMatchObject({ complete: false, watermark: 1,
    gates: [{ limit: { status: 'unknown', value: null, observed: null } }] })
  expect(await inventory(h.home)).toEqual(before)
})

it('keeps the optional service absent and forwards structured storage refusals', async () => {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(GateReader)
  expect(ctx.get('seatGatesQuery')).toBeUndefined()
  const error = { status: 'rejected' as const, error: { code: 'unavailable' as const, message: 'Missing journal.',
    alternative: 'Select an existing home.', retryable: true, effectState: 'none' as const } }
  ctx.provide('seatEngineQuery', { query: async () => error } as Partial<SeatEngineQueryService> as SeatEngineQueryService)
  await vi.waitFor(() => { expect(ctx.get('seatGatesQuery')).toBeDefined() })
  expect(await ctx.get('seatGatesQuery')!.list({ limit: 10 })).toEqual(error)
})
