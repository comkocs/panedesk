import { Context } from '@panedesk/cordis'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JournalSessionLedger, messageEventId } from '@panedesk/dsh-session-ledger'
import type { LedgerCallStart, MessageLedgerEvent } from '@panedesk/dsh-session-ledger'
import { describe, expect, it, vi } from 'vitest'
import { SeatEngineService, SeatGateService } from '@panedesk/dsh-seat'
import type { EngineQueryRequest, EngineQueryResult, ListPendingSeatsRequest, ListSeatGatesRequest } from '@panedesk/dsh-seat'
import LedgerQuery from '../src/index.ts'
import { parseEngineArgs } from '../src/engine-cli.ts'

const query = vi.fn(async (_request: EngineQueryRequest): Promise<EngineQueryResult> => ({ effects: [], complete: true, watermark: 4 }))
const gates = vi.fn(async (_request: ListSeatGatesRequest) => ({ gates: [], complete: true, watermark: 4 }))
const pending = vi.fn(async (_request: ListPendingSeatsRequest) => ({ items: [], complete: true, watermark: 4 }))
const engine = { query, pending } as Partial<SeatEngineService> as SeatEngineService
const gateReader = { list: gates } as Partial<SeatGateService> as SeatGateService

describe('independent engine queries', () => {
  it('queries by seat, gate and pending project without mixing accounting events', async () => {
    const ctx = new Context()
    ctx.provide('seatEngine', engine)
    ctx.provide('seatGates', gateReader)
    await ctx.plugin(LedgerQuery)
    try {
      expect(await ctx.ledgerQuery.execute(['engine', 'events', '--seat', 'seat-a', '--kind', 'open/created'])).toEqual({ code: 0, output: { effects: [], complete: true, watermark: 4 } })
      expect(query).toHaveBeenLastCalledWith({ seat: 'seat-a', kinds: ['open/created'], limit: 100 })
      await ctx.ledgerQuery.execute(['engine', 'gates', '--gate', 'polling', '--json'])
      expect(gates).toHaveBeenLastCalledWith({ gateId: 'polling', limit: 100 })
      await ctx.ledgerQuery.execute(['engine', 'pending', '--project', 'project-a', '--json'])
      expect(pending).toHaveBeenLastCalledWith({ projectId: 'project-a', limit: 100 })
    } finally { await ctx.fiber.dispose() }
  })
  it('keeps accounting queries unchanged without the seat plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(LedgerQuery)
    try {
      const before = await ctx.ledgerQuery.execute(['query'])
      expect((await ctx.ledgerQuery.execute(['engine', 'events'])).output).toMatchObject({ error: { code: 'unavailable' } })
      const after = await ctx.ledgerQuery.execute(['query'])
      expect(after.code).toBe(before.code)
      expect(after.output).toMatchObject({ snapshot: { complete: false, rows: [] } })
      expect(await ctx.ledgerQuery.execute(['engine', 'events', '--kind', 'call/start'])).toMatchObject({ code: 2, output: { error: { code: 'invalid-request' } } })
    } finally { await ctx.fiber.dispose() }
  })
  it('keeps old accounting and message reader bytes unchanged beside the engine namespace and rejects misfiled frames', async () => {
    const home = await mkdtemp(join(import.meta.dirname, '.engine-isolation-'))
    const ctx = new Context()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const ledger = new JournalSessionLedger(ctx, { dshHome: home })
      const nodeId = await ledger.nodeId()
      const start: LedgerCallStart = { sessionId: 'session-a' as LedgerCallStart['sessionId'], rootSessionId: 'session-a' as LedgerCallStart['sessionId'],
        runId: 'run-a' as LedgerCallStart['runId'], nodeId, seat: 'seat-a', window: 'window-a', identitySource: 'startup', accountLabel: 'unknown',
        callId: 'call-a' as LedgerCallStart['callId'], logicalRequestId: 'request-a' as LedgerCallStart['logicalRequestId'], attemptIndex: 0,
        attemptVisibility: 'adapter', provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'model-a', purpose: 'conversation', startedAt: 100,
        cache: { cacheMode: 'unknown', breakReasons: [] }, cacheWriteTiering: { kind: 'unknown' }, priceVersion: 'unknown', priceKey: 'model-a', referencePrice: true }
      await ledger.beginCall(start)
      const data: Extract<MessageLedgerEvent, { kind: 'message/state' }>['data'] = {
        messageId: 'message-a' as never, senderSessionId: null, targetSessionId: null, priority: 'queue', messageClass: 'notice', state: 'withdrawn',
        revision: 0, stateVersion: 1, operationId: 'operation-a' as never, transition: 'withdrawn', observedAt: 100 }
      const messages = await ledger.messages()
      await messages.append({ schemaVersion: 1, kind: 'message/state', nodeId, observedAt: 100, data, eventId: messageEventId({ nodeId, data }) })
      const service = new LedgerQuery(ctx)
      const before = Buffer.from(JSON.stringify({ calls: await service.execute(['query']), messages: await messages.read({}) }))
      const oldFiles = (await readdir(join(home, 'ledger'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
      const oldBytes = await Promise.all(oldFiles.map(file => readFile(join(home, 'ledger', file))))
      const enginePath = join(home, 'ledger', 'engine', 'v1', nodeId, 'events')
      await mkdir(enginePath, { recursive: true })
      const frame = JSON.stringify({ namespace: 'ledger/engine/v1', schemaVersion: 1, nodeId, sequence: 1, effects: [{ kind: 'open/created' }] }) + '\n'
      await writeFile(join(enginePath, 'engine.jsonl'), frame)
      expect(Buffer.from(JSON.stringify({ calls: await service.execute(['query']), messages: await messages.read({}) }))).toEqual(before)
      expect(await Promise.all(oldFiles.map(file => readFile(join(home, 'ledger', file))))).toEqual(oldBytes)
      const callRoot = join(home, 'ledger', 'v1', nodeId, 'events')
      await mkdir(callRoot, { recursive: true })
      await writeFile(join(callRoot, 'misfiled.jsonl'), frame)
      expect((await ledger.snapshot()).complete).toBe(false)
      await expect(ledger.beginCall({ ...start, callId: 'call-b' as LedgerCallStart['callId'] })).rejects.toThrow('Local accounting is unavailable')
      expect((await messages.read({})).complete).toBe(true)
    } finally { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
  })
  it('retains every page and committed watermark without claiming incomplete scans are complete', async () => {
    const ctx = new Context()
    const cursor = { nodeId: 'node-a' as never, sequence: 1, effectIndex: 0 }
    const effects: EngineQueryResult['effects'] = [
      { eventId: 'event-a' as never, kind: 'seat/binding', data: { kind: 'free', sessionId: 'session-a' as never, nodeId: 'node-a' as never, identitySource: 'free' } },
      { eventId: 'event-b' as never, kind: 'seat/binding', data: { kind: 'free', sessionId: 'session-b' as never, nodeId: 'node-a' as never, identitySource: 'free' } },
    ]
    const queryPage = vi.fn<SeatEngineService['query']>()
      .mockResolvedValueOnce({ effects: effects.slice(0, 1), complete: true, watermark: 2, nextCursor: cursor })
      .mockResolvedValueOnce({ effects: effects.slice(1), complete: true, watermark: 2 })
      .mockResolvedValueOnce({ effects: [], complete: false, watermark: 2 })
    ctx.provide('seatEngine', { query: queryPage } as Partial<SeatEngineService> as SeatEngineService)
    const service = new LedgerQuery(ctx)
    try {
      expect(await service.execute(['engine', 'events', '--limit', '1']))
        .toEqual({ code: 0, output: { effects: effects.slice(0, 1), complete: true, watermark: 2, nextCursor: cursor } })
      expect(await service.execute(['engine', 'events', '--limit', '1', '--cursor', JSON.stringify(cursor)]))
        .toEqual({ code: 0, output: { effects: effects.slice(1), complete: true, watermark: 2 } })
      expect(queryPage).toHaveBeenNthCalledWith(2, { limit: 1, cursor })
      expect(await service.execute(['engine', 'events'])).toMatchObject({ output: { effects: [], complete: false, watermark: 2 } })
    } finally { await ctx.fiber.dispose() }
  })
  it('preserves exclusive cursors and timezone-qualified half-open filters', () => {
    const cursor = { nodeId: 'node-a', sequence: 3, effectIndex: 2 }
    expect(parseEngineArgs(['engine', 'events', '--cursor', JSON.stringify(cursor), '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z']))
      .toEqual({ action: 'events', request: { cursor, limit: 100, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } })
    expect(parseEngineArgs(['engine', 'export', '--format', 'jsonl', '--output', 'events.jsonl']))
      .toEqual({ action: 'export', request: { format: 'jsonl', output: 'events.jsonl', query: { limit: 100 } } })
    expect(parseEngineArgs(['engine', 'verify', '--input', 'events.jsonl'])).toEqual({ action: 'verify', request: { input: 'events.jsonl' } })
  })
  it.each([
    ['events', '--kind', 'call/start'], ['events', '--from', '2026-01-01'], ['events', '--limit', '0'],
    ['events', '--cursor', '{}'], ['events', '--node', 'node-a', '--node', 'node-b'],
    ['events', '--from', '2026-01-02T00:00:00Z', '--to', '2026-01-01T00:00:00Z'],
    ['export', '--format', 'csv', '--output', 'events.csv'], ['export', '--format', 'jsonl'], ['verify'], ['unknown'],
  ])('rejects invalid query arguments %j', (...args) => { expect(() => parseEngineArgs(['engine', ...args])).toThrow() })
})
