/**
 * A model probe is one output token on the registered route. A failure keeps
 * the adapter's reason.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import LlmRuntime, { LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly body: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
    super()
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.body(options)
  }
}

async function runtime(body: (options: GenerateOptions) => AsyncIterable<StreamChunk>): Promise<LlmRuntime> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['openai'], new ScriptedAdapter(body))
  return ctx.llm
}

async function * finish(chunk: StreamChunk): AsyncIterable<StreamChunk> {
  yield chunk
}

describe('probeModel', () => {
  it('rejects cancelled remote probes before contacting the adapter', async () => {
    const seen: GenerateOptions[] = []
    const llm = await runtime(async function * (options) {
      seen.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    Object.defineProperty(llm['ctx'], 'invocation', { configurable: true, value: { signal: AbortSignal.abort() } })
    await expect(llm.remoteProbeModel('openai', 'hand-typed', new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled', message: 'Model probe unavailable' })
    expect(seen).toEqual([])
  })
  it('rejects an independently aborted probe signal before contacting the adapter', async () => {
    const seen: GenerateOptions[] = []
    const llm = await runtime(async function * (options) {
      seen.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    Object.defineProperty(llm['ctx'], 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    await expect(llm.remoteProbeModel('openai', 'hand-typed', AbortSignal.abort())).rejects.toMatchObject({ code: 'gateway/cancelled', message: 'Model probe unavailable' })
    expect(seen).toEqual([])
  })
  it('allows a live owner remote probe', async () => {
    const seen: GenerateOptions[] = []
    const llm = await runtime(async function * (options) {
      seen.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const signal = new AbortController().signal
    Object.defineProperty(llm['ctx'], 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal } })
    await expect(llm.remoteProbeModel('openai', 'hand-typed', signal)).resolves.toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ provider: 'openai', model: 'hand-typed', maxTokens: 1 })
  })

  it('reports missing completion instead of success', async () => {
    const llm = await runtime(async function * () {})
    await expect(llm.probeModel('openai', 'unlisted')).resolves.toMatchObject({ ok: false })
  })

  it('reports cancellation instead of success', async () => {
    const llm = await runtime(() => finish({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }))
    await expect(llm.probeModel('openai', 'unlisted')).resolves.toMatchObject({ ok: false, code: 'ABORTED' })
  })

  it('asks for one output token and succeeds on a stop finish', async () => {
    const seen: GenerateOptions[] = []
    const llm = await runtime(async function * (options) {
      seen.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await expect(llm.probeModel('openai', 'hand-typed')).resolves.toEqual({ ok: true })
    expect(seen).toEqual([{
      provider: 'openai',
      model: 'hand-typed',
      maxTokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: '.' }] }],
    }])
  })

  it('keeps the failure reason', async () => {
    const llm = await runtime(() => finish({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'AUTH', message: 'model rejected' },
      },
    }))
    const result = await llm.probeModel('openai', 'hand-typed')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('AUTH')
    expect(result.message).toContain('rejected')
  })
})
