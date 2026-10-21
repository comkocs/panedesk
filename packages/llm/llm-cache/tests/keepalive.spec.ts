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
      await vi.advanceTimersByTimeAsync(3_360_000)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]).toMatchObject({ purpose: 'keepalive', maxTokens: 1, system: 'Stable system' })
      expect(handle.agent.session.seq).toBe(seq)
      expect(ledger?.starts[1].purpose).toBe('keepalive')
      expect(ledger?.fragments.some(fragment => fragment.kind === 'keepalive-request')).toBe(true)
      await handle.dispose()
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(adapter.requests).toHaveLength(2)
    } finally { await ctx.fiber.dispose(); vi.useRealTimers() }
  })
})
