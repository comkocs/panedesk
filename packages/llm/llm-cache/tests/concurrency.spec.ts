import { describe, expect, it } from 'vitest'
import { agentEvents } from '@panedesk/dsh-agent'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { FamilySemaphore } from '../src/concurrency.ts'
import { consume, harness } from './harness.ts'

describe('family admission and call accounting', () => {
  it('hands permits to FIFO waiters and removes cancelled waiters', async () => {
    const gate = new FamilySemaphore([{ modelFamily: 'a', maxInFlight: 1 }])
    const first = await gate.acquire('a')
    const abort = new AbortController()
    const cancelled = gate.acquire('a', abort.signal)
    const rejected = expect(cancelled).rejects.toThrow('cancelled')
    const order: number[] = []
    const second = gate.acquire('a').then((release) => { order.push(2); return release })
    const third = gate.acquire('a').then((release) => { order.push(3); return release })
    abort.abort()
    await rejected
    first(); first()
    const releaseSecond = await second
    expect(order).toEqual([2])
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual([2, 3])
    releaseThird()
    expect(gate.saturated('a')).toBe(false)
    gate.dispose()
    await expect(gate.acquire('a')).rejects.toThrow('closed')
  })

  it('rejects queued work on disposal without revoking acquired permits', async () => {
    const gate = new FamilySemaphore([{ modelFamily: 'a', maxInFlight: 1 }])
    const release = await gate.acquire('a')
    const queued = expect(gate.acquire('a')).rejects.toThrow('closed')
    gate.dispose()
    await queued
    release()
    expect(() => new FamilySemaphore([{ modelFamily: 'a', maxInFlight: 0 }])).toThrow('positive')
    const free = new FamilySemaphore([])
    expect(free.saturated('a')).toBe(false)
    ;(await free.acquire('a'))()
  })

  it.each([undefined, 'compaction', 'session-title', 'keepalive'] as const)('meters %s calls through the same stream entry', async (purpose) => {
    const { ctx, ledger, adapter } = await harness()
    try {
      adapter.chunks = adapter.chunks.map(chunk => chunk.type === 'usage'
        ? { ...chunk, usage: { ...chunk.usage, cacheWriteTokens: 0, cacheWriteLongTokens: 0 } } : chunk)
      await consume(ctx, purpose)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.cache).toBeUndefined()
      expect(ledger?.starts[0]!.cache.cacheMode).toBe('unknown')
      expect(ledger?.starts).toHaveLength(1)
      expect(ledger?.starts[0]).toMatchObject({ purpose: purpose ?? 'conversation', accountLabel: 'unknown', attemptVisibility: 'adapter' })
      expect(ledger?.ends[0]).toMatchObject({ effectiveModel: 'reported-model', responseModelReported: 'different',
        accountLabel: 'route-a', usageState: 'complete', pricingState: 'missing-price', endReason: 'completed' })
      if (purpose === 'keepalive') expect(ledger?.ends[0]!.artifacts?.[0]!.kind).toBe('keepalive-request')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps usage partial when a write-accounting provider omits writes', async () => {
    const { ctx, ledger } = await harness()
    try {
      await consume(ctx)
      expect(ledger?.ends[0]).toMatchObject({ usageState: 'partial', cacheWriteTiering: { kind: 'tiered' } })
      expect(ledger?.ends[0]?.usage).not.toHaveProperty('cacheWriteTokens')
    } finally { await ctx.fiber.dispose() }
  })

  it('does not dispatch a model request when call/start fails', async () => {
    const { ctx, ledger, adapter } = await harness()
    try {
      if (ledger === undefined) throw new Error('missing ledger')
      ledger.failStart = true
      await expect(consume(ctx)).rejects.toThrow('start unavailable')
      expect(adapter.requests).toHaveLength(0)
      expect(ledger.ends).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves failed stream fragments and HTTP counts without inventing usage', async () => {
    const { ctx, ledger, adapter } = await harness()
    try {
      adapter.chunks = [
        { type: 'text-delta', index: 0, text: 'partial output' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limited', status: 429 } } },
      ]
      await consume(ctx)
      expect(ledger?.ends[0]).toMatchObject({ endReason: 'error', usageState: 'missing', http429Count: 1, http503Count: 0 })
      expect(ledger?.ends[0]!.usage).toBeUndefined()
      expect(ledger?.ends[0]!.artifacts?.[0]!.kind).toBe('partial-response')
      expect(JSON.parse(ledger?.fragments[0]!.content ?? '{}')).toMatchObject({ text: 'partial output' })
      expect(ledger?.events.some(event => event.kind === 'alert')).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('records early consumer return and releases admission', async () => {
    const { ctx, ledger } = await harness()
    try {
      for await (const _chunk of ctx.llm.stream({ provider: 'model-provider', model: 'model-a', messages: [] })) break
      expect(ledger?.ends[0]).toMatchObject({ endReason: 'error', upstreamStopReason: 'iterator-closed' })
      await consume(ctx)
      expect(ledger?.ends).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('links final partial output to the durable attempt and records exhausted recovery', async () => {
    const { ctx, ledger, adapter } = await harness()
    try {
      adapter.chunks = [{ type: 'text-delta', index: 0, text: 'partial' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limited', status: 429 } } }]
      const handle = await ctx.agents.create({ sessionId: SessionId('retry-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await agentEvents(ctx, handle.agent).waterfall('agent/request-error', {
        turn: 1, step: 1, provider: 'model-provider', failure: { code: 'RATE_LIMIT', message: 'limited', status: 429 },
        retryPolicy: { mode: 'normal', maxRetries: 0, initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0, retryableCodes: ['RATE_LIMIT'] },
        signal: new AbortController().signal,
      }, async () => undefined)
      expect(ledger?.events.some(event => event.kind === 'retry' && event.phase === 'exhausted')).toBe(true)
      expect(ledger?.events.some(event => event.kind === 'alert' && event.alert.code === 'retry-exhausted' && event.alert.artifact !== undefined)).toBe(true)
      expect(ledger?.events.some(event => event.kind === 'alert' && event.alert.code === 'partial-attempt-linked')).toBe(true)
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('drains active auxiliary streams before the agent ending barrier releases', async () => {
    const { ctx, ledger } = await harness()
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('drain-session'),
        agentOptions: { provider: 'model-provider', model: 'model-a' } })
      const stream = ctx.llm.stream({ provider: 'model-provider', model: 'model-a', messages: [],
        sessionId: handle.agent.id, purpose: 'session-title' })[Symbol.asyncIterator]()
      await stream.next()
      let ended = false
      const ending = ctx.agents.ending(handle.agent).then(() => { ended = true })
      await Promise.resolve()
      expect(ended).toBe(false)
      await stream.return?.()
      await ending
      expect(ledger?.ends).toHaveLength(1)
      await handle.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('runs without an optional ledger', async () => {
    const { ctx, adapter } = await harness({ ledger: false })
    try {
      expect(await consume(ctx)).toHaveLength(3)
      expect(adapter.requests).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })
})
