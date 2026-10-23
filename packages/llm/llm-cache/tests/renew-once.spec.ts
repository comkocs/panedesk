/** Explicit cache refresh uses the existing maintenance and accounting path. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { CacheRenewOperationId } from '../src/types.ts'
import { harness } from './harness.ts'

afterEach(() => { vi.useRealTimers() })

async function ready(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options)
  const handle = await h.ctx.agents.create({ sessionId: SessionId('window-a'),
    agentOptions: { provider: 'model-provider', model: 'model-a' } })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  return { ...h, handle, request: { sessionId: handle.agent.id, operationId: 'refresh-a' as CacheRenewOperationId } }
}

describe('explicit cache renewal', () => {
  it('refreshes a thirty-minute idle session once, marks keepalive in the ledger and adds no conversation body', async () => {
    vi.useFakeTimers()
    const h = await ready()
    try {
      const events = h.handle.agent.session.snapshotEvents()
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      const results = await Promise.all([h.ctx.llmCache.renewOnce(h.request), h.ctx.llmCache.renewOnce(h.request)])
      expect(results).toEqual([{ kind: 'renewed', evidenceAt: Date.now() }, { kind: 'renewed', evidenceAt: Date.now() }])
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.adapter.requests[1]).toMatchObject({ purpose: 'keepalive', maxTokens: 1 })
      expect(h.ledger?.starts.map(start => start.purpose)).toEqual(['conversation', 'keepalive'])
      expect(h.ledger?.fragments.some(fragment => fragment.kind === 'keepalive-request')).toBe(true)
      expect(h.handle.agent.session.snapshotEvents()).toEqual(events)
      if (h.ledger === undefined) throw new Error('Expected ledger')
      h.ledger.restored = { asOf: Date.now(), complete: true, watermarks: {},
        rows: h.ledger.events.map(event => ({ kind: 'event', event })) }
      expect(await h.ctx.llmCache.renewOnce(h.request)).toEqual({ kind: 'uncertain', reason: 'prior-attempt' })
      expect(h.adapter.requests).toHaveLength(2)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects expired, unknown and busy cache evidence with explicit reasons and no refresh', async () => {
    vi.useFakeTimers()
    const h = await ready()
    try {
      const status = vi.spyOn(h.handle.agent, 'status', 'get').mockReturnValue('running')
      expect(await h.ctx.llmCache.renewOnce(h.request)).toEqual({ kind: 'rejected', reason: 'busy' })
      status.mockRestore()
      await vi.advanceTimersByTimeAsync(3_600_001)
      expect(await h.ctx.llmCache.renewOnce({ ...h.request, operationId: 'expired' as CacheRenewOperationId }))
        .toEqual({ kind: 'rejected', reason: 'cache-expired' })
      const empty = await h.ctx.agents.create({ sessionId: SessionId('empty'), agentOptions: {} })
      expect(await h.ctx.llmCache.renewOnce({ ...h.request, sessionId: empty.agent.id }))
        .toEqual({ kind: 'rejected', reason: 'cache-evidence-unavailable' })
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('shares maintenance exclusion and never reports an unconfirmed refresh as renewed', async () => {
    vi.useFakeTimers()
    const h = await ready()
    try {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const maintenance = h.handle.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
      await entered.promise
      try {
        expect(await h.ctx.llmCache.renewOnce(h.request)).toEqual({ kind: 'rejected', reason: 'busy' })
        expect(h.adapter.requests).toHaveLength(1)
      } finally { release.resolve(undefined); await maintenance }
      h.adapter.chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
      await vi.advanceTimersByTimeAsync(1000)
      expect(await h.ctx.llmCache.renewOnce({ ...h.request, operationId: 'unconfirmed' as CacheRenewOperationId }))
        .toEqual({ kind: 'uncertain', reason: 'maintenance-unconfirmed' })
    } finally { await h.ctx.fiber.dispose() }
  })

  it('does not replay a durable renewal claim after recovery', async () => {
    vi.useFakeTimers()
    const h = await ready()
    try {
      await vi.advanceTimersByTimeAsync(1000)
      await h.ctx.llmCache.renewOnce(h.request)
      const seed = h.handle.agent.session.snapshotEvents()
      if (h.ledger === undefined) throw new Error('Expected ledger')
      h.ledger.restored = { asOf: Date.now(), complete: true, watermarks: {}, rows: [
        ...h.ledger.starts.map(start => ({ kind: 'call' as const, start,
          finish: h.ledger!.ends.find(end => end.callId === start.callId)! })),
        ...h.ledger.events.map(event => ({ kind: 'event' as const, event })),
      ] }
      await h.handle.dispose()
      const next = await harness()
      try {
        if (next.ledger === undefined) throw new Error('Expected ledger')
        next.ledger.restored = h.ledger.restored
        await next.ctx.agents.create({ sessionId: h.request.sessionId, seed,
          agentOptions: { provider: 'model-provider', model: 'model-a' } })
        expect(await next.ctx.llmCache.renewOnce(h.request)).toEqual({ kind: 'uncertain', reason: 'prior-attempt' })
        expect(next.adapter.requests).toHaveLength(0)
      } finally { await next.ctx.fiber.dispose() }
    } finally { await h.ctx.fiber.dispose() }
  })
})
