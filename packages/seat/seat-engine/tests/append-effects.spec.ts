/** Effect producers share canonical frames, durable identities and the engine sequence CAS. */
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { GateRegistry } from '@panedesk/dsh-seat-gates'
import { canonical, decodeFrame } from '../src/journal.ts'
import { harness, nodeId } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() { const h = await harness(); cleanups.push(h.close); return h }
const observedAt = '2026-01-01T00:00:00Z'
function request(id = 'decision-a', expectedSequence = 0): Parameters<T.SeatEngineService['appendEffects']>[0] {
  return { decisionId: id as T.EngineDecisionId, expectedSequence, observedAt, policyRevision: 1,
    effects: [{ eventId: `event:${id}` as T.EngineEventId, kind: 'memory/audit', data: {
      sessionId: 'window-a' as SessionId, paths: [], attribution: 'unknown', complete: true, reason: null,
    } }] }
}

describe('engine-owned effect commits', () => {
  it('commits canonical effects with the supplied identity and observation time before resolving', async () => {
    const h = await setup()
    const input = request()
    const result = await h.engine.appendEffects(input)
    expect(result).toMatchObject({ status: 'committed', decision: { decisionId: input.decisionId,
      sequence: 1, observedAt, policyRevision: 1, nodeId, effects: input.effects } })
    if (result.status !== 'committed') throw new Error('Expected a committed frame')
    expect(decodeFrame(canonical(result.decision), h.engine.options.config.maxDecisionBytes)).toEqual(result.decision)
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(restarted.journal.projection.decisions).toEqual([result.decision])
  })

  it('returns the actual sequence for stale and concurrently competing decisions', async () => {
    const h = await setup()
    const results = await Promise.all([h.engine.appendEffects(request()), h.engine.appendEffects(request('decision-b'))])
    expect(results.map(result => result.status).sort()).toEqual(['committed', 'conflict'])
    expect(results.find(result => result.status === 'conflict')).toEqual({ status: 'conflict', actualSequence: 1 })
    expect(await h.engine.appendEffects(request('decision-c'))).toEqual({ status: 'conflict', actualSequence: 1 })
    expect(h.engine.journal.projection.decisions).toHaveLength(1)
  })

  it('returns the original decision for concurrent and recovered identity replays without another write', async () => {
    const h = await setup()
    const input = request()
    const [first, duplicate] = await Promise.all([h.engine.appendEffects(input), h.engine.appendEffects(input)])
    expect(first.status).toBe('committed')
    expect(duplicate).toEqual(first)
    await h.engine.appendEffects(request('decision-b', 1))
    await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.appendEffects(input)).toEqual(first)
    expect(restarted.journal.projection.decisions).toHaveLength(2)
    expect(restarted.journal.projection.sequence).toBe(2)
  })

  it('rejects invalid effect fields without advancing the committed sequence', async () => {
    const h = await setup()
    const input = request()
    input.effects = [{ eventId: 'invalid-a' as T.EngineEventId, kind: 'memory/audit', data: {
      sessionId: 'window-a' as SessionId, paths: [], attribution: 'authorized', complete: false, reason: null,
    } }]
    expect(await h.engine.appendEffects(input)).toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
    expect(await h.engine.appendEffects({ ...request(), effects: [] })).toMatchObject({ status: 'rejected' })
    expect(h.engine.journal.projection.sequence).toBe(0)
    expect(h.engine.journal.projection.decisions).toEqual([])
  })

  it('rejects storage failure instead of reporting a committed effect', async () => {
    const h = await setup()
    const events = join(h.engine.journal.root, 'events')
    await rename(events, `${events}-saved`)
    await writeFile(events, 'Storage is unavailable.')
    await expect(h.engine.appendEffects(request())).rejects.toThrow('Engine commit outcome requires recovery')
    expect(h.engine.journal.projection.sequence).toBe(0)
    expect(h.engine.journal.projection.decisions).toEqual([])
  })

  it('persists a real gate registry hit through appendEffects and recovers its counter', async () => {
    const h = await setup()
    const definition: T.GateDefinition = { id: 'gate-a' as T.GateId, name: 'Neutral tool policy',
      hook: 'before-tool-call', criterion: { type: 'criterion-a' as T.GateCriterion['id'], parameters: {} },
      alternative: 'Use an explicit path.', expiresAt: null, enabled: true, revision: 1, order: 0 }
    const context: T.GateContext = { hook: 'before-tool-call', callId: 'call-a' as T.GateContext['callId'],
      operationId: 'operation-a' as T.SeatOperationId, nodeId, seat: null, sessionId: null, observedAt,
      toolName: 'tool-a', arguments: {}, hasPendingWork: false }
    const registry = new GateRegistry(h.engine, [definition], () => Date.parse(observedAt))
    const dispose = registry.register({ id: definition.criterion.type, async evaluate() {
      return { outcome: 'observe', gateId: definition.id, revision: 1, expiresAt: null, hitCount: 0,
        audit: 'recorded', reason: 'An explicit path is recommended.', alternative: definition.alternative }
    } })
    try {
      expect(await registry.evaluate(context)).toMatchObject([{ outcome: 'observe', audit: 'recorded', hitCount: 1 }])
      expect((await h.engine.query({ kinds: ['gate/hit'], limit: 10 })).effects).toMatchObject([
        { kind: 'gate/hit', data: { context, result: { hitCount: 1, audit: 'recorded' } } },
      ])
      await h.engine.shutdown()
      const restarted = await h.start()
      const recovered = new GateRegistry(restarted, [definition], () => Date.parse(observedAt))
      expect(await recovered.snapshots()).toMatchObject([{ hitCount: 1, watermark: 1 }])
      expect(restarted.journal.projection.decisions).toHaveLength(1)
    } finally { dispose() }
  })
})
