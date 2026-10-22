import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { cacheRemaining, foldCacheState } from '../src/state.ts'
import { scheduleKeepalive } from '../src/keepalive.ts'
import { harness } from './harness.ts'

const policy = { enabled: true, leadSeconds: 240, minimumIntervalSeconds: 60, maxOutputTokens: 1 }
const evidence = { cacheMode: 'explicit' as const, breakReasons: [], ttlSeconds: 3600, lastCacheEvidenceAt: 1000 }

describe('cache evidence and maintenance', () => {
  it('uses evidence timestamps, distinguishes automatic and disabled, and bounds short TTL scheduling', () => {
    expect(cacheRemaining(evidence, 2000)).toEqual({ kind: 'estimated', seconds: 3599, evidenceAt: 1000, ttlSeconds: 3600 })
    expect(cacheRemaining(evidence, 9_000_000)).toMatchObject({ seconds: 0 })
    expect(cacheRemaining(undefined, 0)).toEqual({ kind: 'unknown' })
    expect(cacheRemaining({ ...evidence, cacheMode: 'automatic' }, 0)).toEqual({ kind: 'automatic' })
    expect(cacheRemaining({ ...evidence, cacheMode: 'disabled' }, 0)).toEqual({ kind: 'disabled' })
    expect(scheduleKeepalive(evidence, policy, 1000)).toBe(3_361_000)
    expect(scheduleKeepalive({ ...evidence, ttlSeconds: 30 }, policy, 1000)).toBe(61_000)
    expect(scheduleKeepalive(evidence, { ...policy, enabled: false }, 1000)).toBeUndefined()
    expect(foldCacheState({ asOf: 0, watermarks: {}, complete: true, rows: [] })).toBeUndefined()
  })

  it('restores the frozen prefix and idle maintenance from durable evidence and session history', async () => {
    vi.useFakeTimers()
    const first = await harness({ config: { keepalive: policy } })
    const second = await harness({ config: { keepalive: policy } })
    try {
      first.ctx.systemPrompt.section({ name: 'stable', order: 0, text: 'Original system' })
      const handle = await first.ctx.agents.create({ sessionId: SessionId('restore-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const seed = structuredClone(handle.agent.session.snapshotEvents())
      if (first.ledger === undefined || second.ledger === undefined) throw new Error('missing ledger')
      second.ledger.restored = { asOf: Date.now(), complete: true, watermarks: {}, rows: [
        ...first.ledger.starts.map((start) => {
          const finish = first.ledger?.ends.find(end => end.callId === start.callId)
          return { kind: 'call' as const, start, ...finish === undefined ? {} : { finish } }
        }),
        ...first.ledger.events.map(event => ({ kind: 'event' as const, event })),
      ] }
      await handle.dispose()
      second.ctx.systemPrompt.section({ name: 'stable', order: 0, text: 'Changed system' })
      const restored = await second.ctx.agents.create({ sessionId: SessionId('restore-session'), seed,
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      await vi.advanceTimersByTimeAsync(3_360_000)
      expect(second.adapter.requests[0]).toMatchObject({ purpose: 'keepalive', system: 'Original system', cache: { retention: '1h' } })
      restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await restored.agent.whenIdle()
      expect(second.adapter.requests[1]!.messages[0]).toMatchObject({ content: [{ text: 'Original system' }] })
      await restored.dispose()
    } finally { await first.ctx.fiber.dispose(); await second.ctx.fiber.dispose(); vi.useRealTimers() }
  })

  it('records busy skips and stops after the configured consecutive failure budget', async () => {
    vi.useFakeTimers()
    const { ctx, adapter, ledger } = await harness({ config: { keepalive: policy, keepaliveFailureBudget: 2 } })
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('budget-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const busy = ctx.llm.stream({ provider: 'model-provider', model: 'model-a', messages: [],
        sessionId: handle.agent.id, purpose: 'session-title' })[Symbol.asyncIterator]()
      await busy.next()
      await vi.advanceTimersByTimeAsync(3_360_000)
      expect(ledger?.events.some(event => event.kind === 'alert' && event.alert.code === 'keepalive-skipped-busy')).toBe(true)
      await busy.return?.()
      adapter.chunks = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limited' } } }]
      await vi.advanceTimersByTimeAsync(240_000)
      expect(adapter.requests).toHaveLength(4)
      expect(ledger?.events.some(event => event.kind === 'alert' && event.alert.code === 'keepalive-budget-exhausted')).toBe(true)
      const count = adapter.requests.length
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(adapter.requests).toHaveLength(count)
      await handle.dispose()
    } finally { await ctx.fiber.dispose(); vi.useRealTimers() }
  })

  it('sends one opt-in idle request outside conversation history and persists its snapshot', async () => {
    vi.useFakeTimers()
    const { ctx, adapter, ledger } = await harness({ config: { keepalive: policy } })
    try {
      ctx.systemPrompt.section({ name: 'stable', order: 0, text: 'Stable system' })
      const handle = await ctx.agents.create({ sessionId: SessionId('keepalive-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const seq = handle.agent.session.seq
      const remaining = await ctx.waterfall('llm-cache/remaining', handle.agent, async () => ({ kind: 'unknown' as const }))
      expect(remaining).toMatchObject({ kind: 'estimated', ttlSeconds: 3600 })
      await vi.advanceTimersByTimeAsync(3_360_000)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]).toMatchObject({ purpose: 'keepalive', maxTokens: 1, system: 'Stable system' })
      expect(handle.agent.session.seq).toBe(seq)
      expect(ledger?.starts[1]!.purpose).toBe('keepalive')
      expect(ledger?.fragments.some(fragment => fragment.kind === 'keepalive-request')).toBe(true)
      await handle.dispose()
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(adapter.requests).toHaveLength(2)
    } finally { await ctx.fiber.dispose(); vi.useRealTimers() }
  })
})
