import { describe, expect, it, vi } from 'vitest'
import type { GateContext, GateDefinition, SeatReminderHost } from '@panedesk/dsh-seat'
import { SEAT_GATE_HOOKS } from '@panedesk/dsh-seat'
import { GateRegistry } from '../src/registry.ts'
import { builtinCriterion } from '../src/policies.ts'
import { remindChild } from '../src/continuation.ts'
import { config, policyContext, sessionId } from './harness.ts'

const base = { callId: 'call-a' as GateContext['callId'], operationId: 'operation-a' as GateContext['operationId'],
  nodeId: 'node-a' as GateContext['nodeId'], seat: null, sessionId, observedAt: '2026-01-01T00:00:00Z' }
const row = (type: string, hook: GateDefinition['hook']): GateDefinition => ({
  id: type as GateDefinition['id'], name: type, hook, criterion: { type: type as GateDefinition['criterion']['type'], parameters: {} },
  alternative: 'Use an explicit operation.', expiresAt: null, enabled: true, revision: 1, order: 0,
})

describe('semantic hook executor contracts', () => {
  it('registers all seven hooks and disposes every evaluator without inventing upstream events', async () => {
    const { ctx, engine, effects } = policyContext()
    const contexts: GateContext[] = [
      { ...base, hook: 'before-open', cwd: '/workspace', candidateSeats: [] },
      { ...base, hook: 'before-batch-open', seats: [] },
      { ...base, hook: 'before-memory-write', targetPath: '/ordinary', authorizedDirectories: [], syntax: 'certain' },
      { ...base, hook: 'before-tool-call', toolName: 'probe', arguments: {}, hasPendingWork: false },
      { ...base, hook: 'before-subagent-dispatch', parentSessionId: sessionId, kind: 'start', childSessionId: null, request: {} },
      { ...base, hook: 'after-subagent-return', parentSessionId: sessionId, childSessionId: sessionId, result: 'report' },
      { ...base, hook: 'after-compaction', summary: 'summary', additionalTokenBudget: 10, seatRevision: 1 },
    ]
    const definitions = SEAT_GATE_HOOKS.map(hook => row(hook, hook))
    const registry = new GateRegistry(engine, definitions, Date.now)
    const disposers = definitions.map(definition => registry.register({ id: definition.criterion.type,
      async evaluate() { return { outcome: 'observe', gateId: definition.id, revision: 1, expiresAt: null,
        hitCount: 0, audit: 'recorded', reason: 'Observed.', alternative: definition.alternative } } }))
    try {
      for (const context of contexts) expect(await registry.evaluate(context)).toEqual([expect.objectContaining({ outcome: 'observe' })])
      expect(effects).toHaveLength(7)
      for (const dispose of disposers) dispose()
      await expect(registry.evaluate(contexts[0] as GateContext)).rejects.toThrow('Missing gate criterion')
    } finally { await ctx.fiber.dispose() }
  })
  it('rejects ambiguous headless opening before executor side effects and offers three choices', async () => {
    const { ctx, engine } = policyContext()
    const registry = new GateRegistry(engine, [row('seat-choice', 'before-open')], Date.now)
    registry.register(builtinCriterion(ctx, config, 'seat-choice'))
    const create = vi.fn()
    const execute = async (context: GateContext) => {
      const decisions = await registry.evaluate(context)
      if (decisions.every(item => item.outcome !== 'deny')) create()
      return decisions
    }
    try {
      const context: GateContext = { ...base, hook: 'before-open', cwd: '/workspace', candidateSeats: ['seat-b' as NonNullable<GateContext['seat']>] }
      const denied = await execute(context)
      expect(denied[0]).toMatchObject({ outcome: 'deny', reason: { code: 'seat-choice-required',
        message: 'Choose open-seat, traditional, or cancel.' } })
      expect(JSON.stringify(denied)).toContain('dsh --profile seat open --seat seat-b')
      expect(JSON.stringify(denied)).toContain('seat-b')
      expect(create).not.toHaveBeenCalled()
      await execute({ ...context, callId: 'free-a' as GateContext['callId'], candidateSeats: [] })
      expect(create).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('denies direct and cold continuation before delivery while allowing a new child', async () => {
    const { ctx, engine } = policyContext()
    const registry = new GateRegistry(engine, [row('continuation', 'before-subagent-dispatch')], Date.now)
    registry.register(builtinCriterion(ctx, config, 'continuation'))
    const deliver = vi.fn()
    const manager = async (kind: 'start' | 'continue', callId: string) => {
      const decisions = await registry.evaluate({ ...base, callId: callId as GateContext['callId'], hook: 'before-subagent-dispatch',
        parentSessionId: sessionId, childSessionId: sessionId, request: {}, kind,
        continuationEvidence: { cache: { lastActivityAt: null, cacheTtlMs: null, prefixDigest: null,
          observedAt: base.observedAt, reusableRequest: false }, context: { status: 'known', tokens: 400000,
          contextEpoch: 1, estimated: true, source: 'last-call-usage', observedAt: base.observedAt }, thresholdTokens: 400000 } })
      if (decisions.every(item => item.outcome !== 'deny')) deliver()
      return decisions
    }
    try {
      for (const path of ['direct', 'cold']) expect((await manager('continue', path))[0]).toMatchObject({
        outcome: 'deny', reason: { code: 'subagent-context-limit' }, alternative: 'Start a new subagent with the handoff summary.',
      })
      expect(deliver).not.toHaveBeenCalled()
      await manager('start', 'new')
      expect(deliver).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('audits the three worktree policies as one denial and two non-destructive observations', async () => {
    const { ctx, engine } = policyContext()
    const definitions = ['worktree-client', 'worktree-settle', 'worktree-mature'].map(type => row(type, 'before-tool-call'))
    const registry = new GateRegistry(engine, definitions, Date.now)
    for (const definition of definitions) registry.register(builtinCriterion(ctx, config, definition.criterion.type))
    const context: GateContext = { ...base, hook: 'before-tool-call', toolName: 'worktree-observation', arguments: {}, hasPendingWork: false }
    try {
      for (const event of ['register', 'task-ended', 'mature'] as const) {
        const decisions = await registry.evaluate({ ...context, callId: event as GateContext['callId'], worktreeFacts: {
          event, clientTreeCount: 1, clientTreeLimit: 1, requestedKind: 'client', authorizedForce: false,
          alternative: 'Review the registered tree without deleting it.', mature: true,
        } })
        const hit = decisions.find(item => item.outcome !== 'allow')
        expect(hit).toMatchObject({ outcome: event === 'register' ? 'deny' : 'observe', hitCount: 1,
          alternative: 'Review the registered tree without deleting it.' })
      }
      expect((await registry.snapshots()).map(item => item.hitCount)).toEqual([1, 1, 1])
    } finally { await ctx.fiber.dispose() }
  })
  it('sends handoff reminders as steer with durable epoch and threshold deduplication identities', async () => {
    const sent = new Map<string, unknown>()
    const host: SeatReminderHost = { async send(request) { sent.set(request.id, request); return 'accepted' } }
    const request = { sessionId, thresholdRevision: 2, thresholdTokens: 400000, handoff: 'Remaining task data.',
      context: { status: 'known' as const, tokens: 400000, contextEpoch: 3, estimated: true as const,
        source: 'last-call-usage' as const, observedAt: base.observedAt } }
    expect(await remindChild(host, request)).toBe('sent')
    expect(await remindChild(host, request)).toBe('sent')
    expect([...sent.values()]).toEqual([expect.objectContaining({ kind: 'steer' })])
    expect(JSON.stringify([...sent.values()])).toContain('handoff summary')
    expect(await remindChild(host, { ...request, context: { status: 'unknown', observedAt: base.observedAt } })).toBe('unknown')
    expect(await remindChild(undefined, request)).toBe('unavailable')
  })
})
