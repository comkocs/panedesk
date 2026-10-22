import { Context } from '@panedesk/cordis'
import type { AgentInputScheduler, InputPriority } from '@panedesk/dsh-agent'
import { mutateAgentQueue } from '@panedesk/dsh-agent'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionCommandController } from '../src/commands.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('reply'), textResponse('continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const created = await loop.create(SessionId('queue-control'), { provider: 'mock', model: 'model-a' })
  const agent = created as typeof created & AgentInputScheduler
  const owners = { resolveAgent: vi.fn<ApiSessionAgentController['resolveAgent']>().mockResolvedValue({ agent }) }
  const controller = new SessionCommandController(ctx, owners as Pick<ApiSessionAgentController, 'resolveAgent'> as ApiSessionAgentController, '/workspace')
  const message = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
  return { ctx, agent, adapter, owners, controller, message }
}

const priorities: readonly InputPriority[] = ['queue', 'steer', 'immediate']
const changes = priorities.flatMap(from => priorities.map(to => [from, to] as const))

describe('Session queue reprioritization', () => {
  it.each(changes)('moves %s input to %s without changing its identity', async (from, to) => {
    const { ctx, agent, controller, message, owners } = await harness()
    const gate = Promise.withResolvers<undefined>()
    const parked = agent.runMaintenance(async () => { await gate.promise })
    agent.enqueue(message, { priority: from, passive: false, wakeup: false })
    expect(await controller.updateQueue({ sessionId: agent.id, itemId: message.id, action: { kind: 'reprioritize', priority: to } }))
      .toEqual({ accepted: true })
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    expect(pending).toEqual([message])
    const scheduled = agent.session.snapshotEvents().findLast(event => event.type === 'agent/input/transition' && event.data.phase === 'scheduled')
    expect(scheduled?.data).toMatchObject({ scheduling: [{ priority: to }] })
    expect(owners.resolveAgent).not.toHaveBeenCalled()
    const projected = ctx.sessionProjections.stateOf(agent.session, 'inbox')
    expect(projected?.[to === 'queue' ? 'next-turn' : 'next-step']).toEqual([message])
    agent.inbox.remove(message.id)
    gate.resolve(undefined)
    await parked
  })

  it.each(['remove', 'edit', 'reprioritize'] as const)('separates claimed and injected refusals for %s', async (kind) => {
    const { ctx, agent, controller, message } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    ctx.on('agent/request', async (_payload, next) => {
      entered.resolve(undefined)
      await gate.promise
      return next()
    })
    const action = kind === 'edit' ? { kind, content: [{ type: 'text' as const, text: 'edited' }] }
      : kind === 'reprioritize' ? { kind, priority: 'immediate' as const } : { kind }
    agent.enqueue(message, { priority: 'queue', passive: false, wakeup: true })
    await entered.promise
    await expect(controller.updateQueue({ sessionId: agent.id, itemId: message.id, action }))
      .rejects.toMatchObject({ code: 'session/queue-item-claimed', details: { itemId: message.id, state: 'claimed' } })
    gate.resolve(undefined)
    await agent.whenIdle()
    await expect(controller.updateQueue({ sessionId: agent.id, itemId: message.id, action }))
      .rejects.toMatchObject({ code: 'session/queue-item-injected', details: { itemId: message.id, state: 'injected' } })
  })

  it('cancels the active turn when a queued item becomes immediate', async () => {
    const { ctx, agent, controller, message, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const stop = ctx.on('agent/request', async (_payload, next) => {
      entered.resolve(undefined)
      await gate.promise
      return next()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'active' }], source: { kind: 'user' } }))
    await entered.promise
    agent.enqueue(message, { priority: 'queue', passive: false, wakeup: false })
    const cancel = vi.spyOn(agent, 'cancel')
    await controller.updateQueue({ sessionId: agent.id, itemId: message.id, action: { kind: 'reprioritize', priority: 'immediate' } })
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'interjection' }, { keepInbox: true })
    stop()
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests[0]?.messages.some(item => item.id === message.id)).toBe(true)
  })

  it('applies the public mutation primitive without resolving or activating an owner', async () => {
    const { agent, message, adapter, owners } = await harness()
    agent.enqueue(message, { priority: 'queue', passive: false, wakeup: false })
    expect(mutateAgentQueue(agent, message.id, { kind: 'reprioritize', priority: 'steer' })).toEqual({ kind: 'applied' })
    expect(mutateAgentQueue(agent, message.id, { kind: 'remove' })).toEqual({ kind: 'applied' })
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(owners.resolveAgent).not.toHaveBeenCalled()
  })
})
