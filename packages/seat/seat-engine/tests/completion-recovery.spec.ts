/** Deferred completion input wakes when the engine's budget evidence recovers. */
import { expect, it, vi } from 'vitest'
import type { Agent } from '@panedesk/dsh-agent'
import type { MessageId } from '@panedesk/dsh-llm'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type * as T from '@panedesk/dsh-seat'
import { composition } from './composition-fixture.ts'
import { SeatEngine } from '../src/engine.ts'
import { auto, sourceId, trigger } from './fixtures.ts'

it('readmits a deferred live Session after owner-release recovery and responds exactly once', async () => {
  const f = await composition(false, { engineConfig: { failureRecovery: { retryInitialMs: 50, ownerReleaseMaxAttempts: 3 } } })
  f.adapter.finish()
  let parent: Agent | undefined
  let release = false
  let clock = 0
  const timer = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  try {
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        parent = (await f.ctx.agents.create({ sessionId: open.sessionId,
          agentOptions: { provider: 'mock', model: 'model-a' } })).agent
        return parent.id
      }, configure: async () => {}, opening: async () => ({ messageId: 'retained-opening' as MessageId, state: 'completed' }),
      owner: async () => { if (!release) return 'alive'; release = false; clock += 2001; return 'dead' },
      wakeSender: async () => 'sent' })
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    if (!parent) throw new Error('Missing parent')
    const active = parent
    const previous = engine.journal.projection.resources.get(active.id)!
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    release = true
    await engine.drive()
    expect((await engine.nodeStatus()).engine).toBe('unavailable')
    expect(await engine.admitTurn(active.id)).toEqual({ status: 'defer', reason: 'owner-unknown' })
    const sent = await f.ctx.messageDelivery.send({ target: { sessionId: active.id }, content: 'Continue retained work.',
      messageClass: 'handoff', priority: 'steer', operationId: 'retained-direct-message' as OperationId })
    expect(sent.deliveryOutcome).toBe('accepted')
    await expect.poll(() => active.inbox.nextStep.length).toBe(1)
    await active.whenIdle()
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
    now.mockRestore()
    await expect.poll(async () => { await engine.drive(); return (await engine.nodeStatus()).engine }).toBe('running')
    await expect.poll(async () => (await f.ctx.messageDelivery.status(sent.messageId)).state).toBe('responded')
    await active.whenIdle()
    await engine.drive()
    await engine.drive()
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(1)
    expect(engine.journal.projection.fenced.has(previous.owner.ownerEpoch)).toBe(true)
    const resumed = engine.journal.projection.resources.get(active.id)
    expect(resumed).toBeDefined()
    expect(resumed?.owner.ownerEpoch).not.toBe(previous.owner.ownerEpoch)
  } finally { timer.mockRestore(); vi.restoreAllMocks(); await f.close() }
}, 20000)

it('accepts a resent message after the failed opening model becomes available without replaying the opening', async () => {
  const f = await composition(false, { engineConfig: { failureRecovery: { retryInitialMs: 50 } } })
  f.adapter.finish()
  let parent: Agent | undefined
  let available = false
  const opening = vi.fn(async () => ({ messageId: 'original-opening' as MessageId, state: 'completed' as const }))
  try {
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        parent = (await f.ctx.agents.create({ sessionId: open.sessionId,
          agentOptions: { provider: 'mock', model: 'model-a' } })).agent
        return parent.id
      }, configure: async (_open, stage) => {
        if (stage === 'model' && !available) throw Object.assign(new Error('Model unavailable'), {
          isDSHRemoteError: true, code: 'session/model-unavailable', details: { provider: 'mock', model: 'model-a' },
        })
      }, opening, owner: async () => 'alive', wakeSender: async () => 'sent' })
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    if (!parent) throw new Error('Missing failed Session')
    const active = parent
    expect(engine.journal.projection.opens.get(active.id)?.phase).toBe('opening-failed')
    expect((await engine.nodeStatus()).engine).toBe('running')
    await engine.drive()
    expect(f.adapter.requests).toHaveLength(0)
    available = true
    const sent = await f.ctx.messageDelivery.send({ target: { sessionId: active.id }, content: 'Resent after model repair.',
      messageClass: 'handoff', priority: 'steer', operationId: 'repaired-model-message' as OperationId })
    expect(sent.deliveryOutcome).toBe('accepted')
    await expect.poll(async () => (await f.ctx.messageDelivery.status(sent.messageId)).state).toBe('responded')
    await active.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(f.adapter.requests[0])).toContain('Resent after model repair.')
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(opening).not.toHaveBeenCalled()
    expect(engine.journal.projection.opens.get(active.id)).toMatchObject({ phase: 'active', failure: null })
    expect((await engine.nodeStatus()).openingFailures ?? []).toEqual([])
  } finally { await f.close() }
}, 20000)

it('wakes an idle parent with retained completion input after admission recovers', async () => {
  const f = await composition()
  f.adapter.finish()
  let parent: Agent | undefined
  try {
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        parent = (await f.ctx.agents.create({ sessionId: open.sessionId, agentOptions: { provider: 'mock', model: 'model-a' } })).agent
        return parent.id
      }, configure: async () => {}, opening: async () => ({ messageId: 'parent-opening' as MessageId, state: 'completed' }),
      owner: async () => 'alive', wakeSender: async () => 'sent' })
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    if (!parent) throw new Error('Missing parent')
    const active = parent
    expect(await engine.configureBudget({ sessionId: active.id, limits: { windowBudgetUsd: '100' as T.MicroUsd },
      expectedRevision: 0, authorizationRef: 'budget-owner' as T.AuthorizationRef,
      operationId: 'parent-budget' as T.SeatOperationId })).toMatchObject({ status: 'configured' })
    const snapshot = await f.ctx.sessionLedger.snapshot()
    const unavailable = vi.spyOn(f.ctx.sessionLedger, 'snapshot').mockResolvedValue({ ...snapshot, complete: false })
    const sent = await f.ctx.messageDelivery.send({ target: { sessionId: active.id }, content: 'Child task completed.',
      messageClass: 'handoff', priority: 'steer', operationId: 'child-completion' as OperationId })
    expect(sent.deliveryOutcome).toBe('accepted')
    await expect.poll(() => active.inbox.nextStep.length).toBe(1)
    await active.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(await engine.admitTurn(active.id)).toEqual({ status: 'defer', reason: 'budget-unverifiable' })
    unavailable.mockRestore()
    await engine.drive()
    await expect.poll(() => f.adapter.requests.length).toBe(1)
    await active.whenIdle()
    expect(JSON.stringify(f.adapter.requests[0])).toContain('Child task completed.')
    expect(active.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)
