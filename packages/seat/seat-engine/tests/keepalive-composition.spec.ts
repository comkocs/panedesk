/** Real cache maintenance retains Session text and durable call attribution. */
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { CacheRenewOperationId } from '@panedesk/dsh-llm-cache'
import type { SeatOperationId } from '@panedesk/dsh-seat'
import { composition } from './composition-fixture.ts'
import { auto, harness, trigger } from './fixtures.ts'

it('A28 routes automatic and manual renewal through real cache maintenance without conversation text', async () => {
  const f = await composition(true)
  f.adapter.finish()
  const h = await harness({}, {
    remaining: async (sessionId) => {
      const agent = f.ctx.agents.get(sessionId)
      return agent ? f.ctx.llmCache.remaining(agent) : { kind: 'unknown' }
    },
    renew: (sessionId, operationId) => f.ctx.llmCache.renewOnce({ sessionId,
      operationId: operationId as string as CacheRenewOperationId }),
  })
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    await auto(h.engine); await h.engine.accept(trigger()); await h.engine.drive()
    const sessionId = h.creates[0]
    if (!sessionId) throw new Error('Missing engine window')
    const { agent } = await f.ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'model-a' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Begin the assigned task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    await h.engine.drive()
    const before = agent.session.snapshotEvents()
    vi.setSystemTime(Date.now() + 56 * 60000)
    await h.engine.drive(); await h.engine.drive()
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.adapter.requests[1]).toMatchObject({ purpose: 'keepalive', maxTokens: 1 })
    expect(agent.session.snapshotEvents()).toEqual(before)
    const request = { sessionId, operationId: 'manual-cache-a' as SeatOperationId }
    vi.setSystemTime(Date.now() + 60000)
    expect(await h.engine.renew(request)).toMatchObject({ status: 'renewed' })
    expect(f.adapter.requests).toHaveLength(3)
    expect(agent.session.snapshotEvents()).toEqual(before)
    const costs = await f.ctx.sessionLedger.snapshot({ sessionId })
    expect(costs.rows.filter(row => row.kind === 'call' && row.start.purpose === 'keepalive')).toHaveLength(2)
    await h.engine.shutdown(); const recovered = await h.start()
    expect(await recovered.renew(request)).toMatchObject({ status: 'renewed' })
    expect(f.adapter.requests).toHaveLength(3)
    const renewals = [...recovered.journal.projection.renewals.values()]
    expect(renewals.filter(item => item.phase === 'renewed').map(item => item.source).sort()).toEqual(['auto', 'manual'])
    expect(renewals.filter(item => item.phase === 'skipped')).toMatchObject([{ source: 'auto', reason: 'evidence-unavailable' }])
  } finally {
    vi.useRealTimers()
    await h.close(); await f.close()
  }
}, 20000)
