import { describe, expect, it } from 'vitest'
import type { EngineDecision, EngineEffect, GateContext, GateCriterion, GateDefinition, SeatEngineService } from '@panedesk/dsh-seat'
import { GateRegistry } from '../src/registry.ts'

const definition: GateDefinition = { id: 'gate-a' as GateDefinition['id'], name: 'Neutral tool policy', hook: 'before-tool-call', criterion: { type: 'deny-a' as GateCriterion['id'], parameters: {} }, alternative: 'Use an explicit path.', expiresAt: '2026-01-01T00:01:00Z', enabled: true, revision: 1, order: 0 }
const context = (id: string): GateContext => ({ hook: 'before-tool-call', callId: id as GateContext['callId'], operationId: 'operation-a' as GateContext['operationId'], nodeId: 'node-a' as GateContext['nodeId'], seat: null, sessionId: null, observedAt: '2026-01-01T00:00:00Z', toolName: 'tool-a', arguments: {}, hasPendingWork: false })
const criterion: GateCriterion = { id: definition.criterion.type, async evaluate(_context, row) {
  return { outcome: 'deny', gateId: row.id, revision: row.revision, expiresAt: row.expiresAt, hitCount: 0, audit: 'recorded', alternative: row.alternative,
    reason: { code: 'gate-denied', message: 'An explicit path is required.', alternative: row.alternative, retryable: false, effectState: 'none' } }
} }

function engine() {
  const effects: EngineEffect[] = []
  let sequence = 0
  const service: Pick<SeatEngineService, 'query' | 'appendEffects'> = {
    async query() { return { effects: [...effects], watermark: sequence, complete: true } },
    async appendEffects(request) {
      if (request.expectedSequence !== sequence) return { status: 'conflict', actualSequence: sequence }
      effects.push(...request.effects)
      const decision: EngineDecision = { ...request, effects: request.effects, sequence: ++sequence, nodeId: 'node-a' as EngineDecision['nodeId'], namespace: 'ledger/engine/v1', schemaVersion: 1, digest: 'digest-a' as EngineDecision['digest'], byteLength: 1 }
      return { status: 'committed', decision }
    },
  }
  return { service, effects }
}

describe('committed gate counters', () => {
  it('returns an alternative on every hit, counts three calls, and expires once across restart', async () => {
    const journal = engine()
    let now = Date.parse('2026-01-01T00:00:00Z')
    const registry = new GateRegistry(journal.service, [definition], () => now)
    registry.register(criterion)
    for (let index = 1; index <= 3; index++) {
      expect(await registry.evaluate(context(`call-${index}`))).toEqual([expect.objectContaining({ outcome: 'deny', hitCount: index, alternative: 'Use an explicit path.', audit: 'recorded' })])
    }
    expect((await registry.evaluate(context('call-3')))[0]?.hitCount).toBe(3)
    const restarted = new GateRegistry(journal.service, [definition], () => now)
    restarted.register(criterion)
    expect((await restarted.snapshots())[0]?.hitCount).toBe(3)
    now += 60000
    expect((await restarted.evaluate(context('call-4')))[0]).toMatchObject({ outcome: 'allow', hitCount: 3 })
    await restarted.evaluate(context('call-5'))
    expect(journal.effects.filter(effect => effect.kind === 'gate/hit')).toHaveLength(3)
    expect(journal.effects.filter(effect => effect.kind === 'gate/expired')).toHaveLength(1)
  })
  it('serializes concurrent hit increments with engine compare-and-swap', async () => {
    const journal = engine()
    const registry = new GateRegistry(journal.service, [definition], () => 0)
    registry.register(criterion)
    await Promise.all([registry.evaluate(context('call-a')), registry.evaluate(context('call-b'))])
    expect((await registry.snapshots())[0]?.hitCount).toBe(2)
  })
  it('keeps a high-cost denial when audit publication fails and releases evaluator registrations', async () => {
    const journal = engine()
    journal.service.appendEffects = async () => { throw new Error('unavailable') }
    const registry = new GateRegistry(journal.service, [definition], () => 0)
    const dispose = registry.register(criterion)
    expect((await registry.evaluate(context('call-a')))[0]).toMatchObject({ outcome: 'deny', audit: 'unavailable', alternative: 'Use an explicit path.' })
    dispose()
    await expect(registry.evaluate(context('call-b'))).rejects.toThrow('Missing gate criterion')
  })
  it('observes a malformed settled-child report without reversing settlement', async () => {
    const journal = engine()
    const registry = new GateRegistry(journal.service, [{ ...definition, hook: 'after-subagent-return' }], () => 0)
    registry.register(criterion)
    const base = context('call-a')
    const result = await registry.evaluate({ ...base, hook: 'after-subagent-return', parentSessionId: 'parent-a' as NonNullable<GateContext['sessionId']>, childSessionId: 'child-a' as NonNullable<GateContext['sessionId']>, result: 'report' })
    expect(result[0]).toMatchObject({ outcome: 'observe', alternative: 'Use an explicit path.' })
  })
})
