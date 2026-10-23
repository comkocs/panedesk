/** Ordered policy evaluation derives counters exclusively from committed engine facts. */
import type { EngineEffect, EngineEventId, EngineDecisionId, GateContext, GateCriterion, GateDefinition, GateResult, GateSnapshot, SeatEngineService } from '@panedesk/dsh-seat'

/** Registry owns installed evaluators; the engine owns durable invocation deduplication. */
export class GateRegistry {
  private readonly criteria = new Map<string, GateCriterion>()
  constructor(private readonly engine: Pick<SeatEngineService, 'query' | 'appendEffects'>, private readonly definitions: readonly GateDefinition[], private readonly now: () => number) {
    const ids = new Set<string>()
    for (const definition of definitions) {
      if (ids.has(definition.id) || !definition.alternative.trim() || (definition.expiresAt !== null && !Number.isFinite(Date.parse(definition.expiresAt)))) throw new Error('Invalid gate configuration.')
      ids.add(definition.id)
    }
  }

  /** Install one evaluator and release only this registration.
   * @param criterion - installed, typed policy implementation.
   * @returns idempotent disposer.
   */
  register(criterion: GateCriterion): () => void {
    if (this.criteria.has(criterion.id)) throw new Error('Gate criterion is already registered.')
    this.criteria.set(criterion.id, criterion)
    return () => { if (this.criteria.get(criterion.id) === criterion) this.criteria.delete(criterion.id) }
  }

  private async history(): Promise<{ effects: EngineEffect[]; watermark: number }> {
    const effects: EngineEffect[] = []
    let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
    for (;;) {
      const page = await this.engine.query({ kinds: ['gate/hit', 'gate/expired'], limit: 1000, ...cursor === undefined ? {} : { cursor } })
      effects.push(...page.effects)
      if (page.complete) return { effects, watermark: page.watermark }
      if (page.nextCursor === undefined || JSON.stringify(page.nextCursor) === JSON.stringify(cursor)) throw new Error('Gate history is incomplete.')
      cursor = page.nextCursor
    }
  }

  /** Read counters by configured revision after host restart.
   * @returns committed snapshots without mutable configuration counters.
   */
  async snapshots(): Promise<readonly GateSnapshot[]> {
    const history = await this.history()
    return this.definitions.map(definition => this.snapshot(definition, history))
  }

  private snapshot(definition: GateDefinition, history: { effects: readonly EngineEffect[]; watermark: number }): GateSnapshot {
    let hitCount = 0
    let lastHitAt: string | null = null
    let expired = false
    for (const effect of history.effects) {
      if (effect.kind !== 'gate/hit' && effect.kind !== 'gate/expired') continue
      if (effect.data.definition.id !== definition.id || effect.data.definition.revision !== definition.revision) continue
      if (effect.kind === 'gate/expired') expired = true
      else { hitCount = Math.max(hitCount, effect.data.result.hitCount); lastHitAt = effect.data.context.observedAt }
    }
    return { definition, hitCount, lastHitAt, expired, watermark: history.watermark }
  }

  /** Evaluate the actual executor call; duplicate stable calls never increment twice.
   * @param context - trusted execution facts.
   * @returns ordered outcomes with audit failure separate from denial.
   */
  async evaluate(context: GateContext): Promise<readonly GateResult[]> {
    const results: GateResult[] = []
    const ordered = this.definitions.filter(row => row.enabled && row.hook === context.hook)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    for (const definition of ordered) {
      const criterion = this.criteria.get(definition.criterion.type)
      if (!criterion) throw new Error(`Missing gate criterion: ${definition.criterion.type}`)
      const result = await this.evaluateOne(context, definition, criterion)
      results.push(result)
      if (result.outcome === 'deny') break
    }
    return results
  }

  private async evaluateOne(context: GateContext, definition: GateDefinition, criterion: GateCriterion): Promise<GateResult> {
    for (;;) {
      const history = await this.history()
      const snapshot = this.snapshot(definition, history)
      const facts = { gateId: definition.id, revision: definition.revision, hitCount: snapshot.hitCount, expiresAt: definition.expiresAt, audit: 'recorded' as const }
      const expired = definition.expiresAt !== null && this.now() >= Date.parse(definition.expiresAt)
      if (expired && snapshot.expired) return { ...facts, outcome: 'allow' }
      const old = history.effects.find(effect => effect.kind === 'gate/hit' && effect.data.definition.id === definition.id && effect.data.definition.revision === definition.revision && effect.data.context.callId === context.callId)
      if (!expired && old?.kind === 'gate/hit') return old.data.result
      const evaluated = expired ? { ...facts, outcome: 'allow' as const } : await criterion.evaluate(context, definition)
      if (!expired && evaluated.outcome === 'allow' && definition.criterion.type !== 'polling') return { ...evaluated, ...facts }
      const result: GateResult = evaluated.outcome === 'deny' && context.hook === 'after-subagent-return'
        ? { ...facts, outcome: 'observe', reason: evaluated.reason.message, alternative: evaluated.alternative }
        : { ...evaluated, ...facts }
      if (result.outcome !== 'allow') result.hitCount++
      const eventId = `gate:${definition.id}:${definition.revision}:${expired ? 'expired' : context.callId}` as EngineEventId
      const effect: EngineEffect = expired
        ? { eventId, kind: 'gate/expired', data: { definition, hitCount: snapshot.hitCount, expiredAt: new Date(this.now()).toISOString() } }
        : { eventId, operationId: context.operationId, kind: 'gate/hit', data: { definition, context, result } }
      try {
        const committed = await this.engine.appendEffects({ decisionId: eventId as string as EngineDecisionId, expectedSequence: history.watermark, observedAt: new Date(this.now()).toISOString(), policyRevision: definition.revision, effects: [effect] })
        if (committed.status === 'conflict') continue
        if (committed.status === 'rejected') return { ...result, audit: 'unavailable' }
        return result
      } catch (error) {
        // A denied high-cost operation stays denied when its audit store fails.
        if (error instanceof Error) return { ...result, audit: 'unavailable' }
        throw error
      }
    }
  }
}
