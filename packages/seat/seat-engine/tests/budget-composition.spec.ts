/** A17 exercises budget admission against real AgentLoop and durable M5 delivery. */
import { expect, it } from 'vitest'
import type { Agent } from '@panedesk/dsh-agent'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type { LedgerCallStart, LedgerCallFinish } from '@panedesk/dsh-session-ledger'
import type * as T from '@panedesk/dsh-seat'
import { composition } from './composition-fixture.ts'
import { SeatEngine } from '../src/engine.ts'
import { digest } from '../src/journal.ts'
import { auto, seat, sourceId, trigger } from './fixtures.ts'

it('A17 persists one handoff/steer warning, completes the admitted turn and leaves the next input unclaimed', async () => {
  const f = await composition()
  const { ctx, adapter } = f
  const callbacks: T.SeatCallbackPayload[] = []
  let agent: Agent | undefined
  try {
    await expect.poll(() => ctx.get('seatEngine') !== undefined).toBe(true)
    const engine = ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Production engine is not mounted')
    await engine.ready()
    const send = (sessionId: Agent['id'], operationId: T.SeatOperationId, content: string) => ctx.messageDelivery.send({
      target: { sessionId }, operationId: digest(operationId) as string as OperationId, content, messageClass: 'handoff', priority: 'steer',
    })
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null,
      callback: async (payload) => { callbacks.push(payload) } })
    engine.registerExecutor({
      observe: async open => ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        agent = (await ctx.agents.create({ sessionId: open.sessionId, agentOptions: { provider: 'mock', model: 'model-a' } })).agent
        return agent.id
      },
      configure: async () => {},
      opening: async (open) => {
        const result = await send(open.sessionId, open.openingOperationId, 'Begin the assigned task.')
        if (result.deliveryOutcome === 'rejected') throw new Error(result.reason)
        await agent?.whenIdle()
        return { messageId: result.messageId, state: 'completed' }
      },
      owner: async () => 'alive',
      wakeSender: () => { throw new Error('Unused timeout wake') },
      notifyBudget: async (request) => {
        const result = await send(request.sessionId, request.operationId, 'Budget has reached 80%. Finish the current task.')
        if (result.deliveryOutcome === 'rejected') throw new Error(result.reason)
      },
    })
    await auto(engine)
    await engine.accept(trigger()); await engine.drive()
    if (!agent) throw new Error('Agent was not created')
    const active = agent
    active.wake?.()
    await expect.poll(() => adapter.requests.length).toBe(1)
    await active.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(await engine.configureBudget({ sessionId: active.id, limits: { windowBudgetUsd: '100' as T.MicroUsd },
      expectedRevision: 0, authorizationRef: 'authorization-a' as T.AuthorizationRef,
      operationId: 'budget-config-a' as T.SeatOperationId })).toMatchObject({ status: 'configured' })
    const recordCost = async (id: string, costUsd: string) => {
      const start: LedgerCallStart = { callId: id as LedgerCallStart['callId'], runId: 'run-a' as LedgerCallStart['runId'],
        logicalRequestId: id as LedgerCallStart['logicalRequestId'], sessionId: active.id, rootSessionId: active.id,
        nodeId: await ctx.sessionLedger.nodeId(), seat, window: 'window-a', identitySource: 'settings', accountLabel: 'account-a',
        attemptIndex: 0, attemptVisibility: 'physical', provider: 'mock', modelFamily: 'mock', requestedModel: 'model-a',
        purpose: 'conversation', startedAt: Date.now(), cache: { breakReasons: [], cacheMode: 'unknown' },
        cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, priceVersion: 'test-v1', priceKey: 'model-a', referencePrice: true }
      const finish: LedgerCallFinish = { callId: start.callId, endedAt: Date.now(), observedAt: Date.now(),
        responseModelReported: 'not-reported', effectiveModel: 'model-a', usageState: 'missing', pricingState: 'missing-usage',
        wallMs: 1, modelInFlightMs: 1, queueMs: 0, backoffMs: 0, waits: [], compactionCount: 0, compactionTimes: [],
        endReason: 'completed', recovered: false, costUsd }
      await ctx.sessionLedger.beginCall(start); await ctx.sessionLedger.finishCall(finish)
    }
    await recordCost('cost-a', '0.00008')
    await engine.drive(); await adapter.started
    await engine.drive()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1])).toContain('Budget has reached 80%')
    await recordCost('cost-b', '0.00002')
    await engine.drive()
    const queued = await ctx.messageDelivery.send({ target: { sessionId: active.id },
      operationId: 'queued-a' as OperationId, content: 'Do the next task.', messageClass: 'handoff', priority: 'queue' })
    expect(queued.deliveryOutcome).not.toBe('rejected')
    adapter.finish(); await active.whenIdle(); await engine.drive()
    expect(adapter.requests).toHaveLength(2)
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    await expect.poll(() => active.inbox.nextTurn.length + active.inbox.nextStep.length).toBeGreaterThan(0)
    expect(await engine.admitTurn(active.id)).toEqual({ status: 'defer', reason: 'budget-stopped' })
    expect(callbacks.filter(payload => payload.kind === 'budget-stopped')).toHaveLength(1)
    expect(callbacks.find(payload => payload.kind === 'budget-stopped')).toMatchObject({ sessionId: active.id,
      budgetSnapshot: { windowCost: '100', costState: 'known' } })
    // Driver quiescence does not include the persistence provider's buffered writes.
    await expect(ctx.sessions.flush(active.session)).resolves.toBe(true)
    const handle = await ctx.sessionPersistence.open(active.id, 'read')
    try {
      const persisted = (await handle.read()).events
      expect(JSON.stringify(persisted)).toContain('Budget has reached 80%')
      expect(JSON.stringify(persisted)).toContain('handoff')
      expect(persisted.filter(event => event.type === 'turn/end')).toHaveLength(2)
    } finally { await handle.close() }
    if (!(engine instanceof SeatEngine)) throw new Error('Production engine is not mounted')
    const warnings = engine.journal.projection.decisions.flatMap(decision => decision.effects)
      .filter(effect => effect.kind === 'budget/warning')
    expect(warnings).toHaveLength(1)
  } finally { await f.close() }
}, 20000)
