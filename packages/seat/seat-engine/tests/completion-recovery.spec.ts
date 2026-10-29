/** Deferred completion input wakes when the engine's budget evidence recovers. */
import { expect, it, vi } from 'vitest'
import type { Agent } from '@panedesk/dsh-agent'
import type { MessageId } from '@panedesk/dsh-llm'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type * as T from '@panedesk/dsh-seat'
import { composition } from './composition-fixture.ts'
import { SeatEngine } from '../src/engine.ts'
import { auto, sourceId, trigger } from './fixtures.ts'

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
