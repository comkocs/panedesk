import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage, LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@panedesk/dsh-llm'
import { harness } from './harness.ts'
import type { Context } from '@panedesk/cordis'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

class InterruptibleAdapter extends LlmAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  calls = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls++
    yield { type: 'text-delta', index: 0, text: 'partial answer' }
    if (this.calls === 1) {
      this.entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve()
        else request.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      request.signal?.throwIfAborted()
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('records interjection cancellation detail and a real inbox insertion breakpoint before continuation', async () => {
  const { ctx, ledger } = await harness()
  contexts.push(ctx)
  const adapter = new InterruptibleAdapter()
  ctx.llm.registerAdapter(['interruptible'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('seat-a'), agentOptions: { provider: 'interruptible', model: 'model-a' } })
  const input = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  let interrupted = false
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'aborted'
      && event.data.reason.reason.kind === 'interjection') interrupted = true
  })
  try {
    handle.agent.followup(input('Start'))
    await adapter.entered.promise
    handle.agent.cancel({ kind: 'interjection' }, { keepInbox: true })
    handle.agent.followup(input('Continue with this correction'))
    await handle.agent.whenIdle()
    expect(adapter.calls).toBe(2)
    expect(ledger?.ends[0]).toMatchObject({ endReason: 'cancelled', upstreamStopReason: 'interjection', cache: { breakReasons: ['interjection'] } })
    expect(ledger?.ends[0]?.artifacts?.some(item => item.kind === 'partial-response')).toBe(true)
    expect(ledger?.starts[1]?.cache.breakReasons).toContain('interjection')
    expect(ledger?.ends[1]?.endReason).toBe('completed')
    expect(ledger?.events.some(event => event.kind === 'cache/break' && event.evidence.breakReasons.includes('interjection'))).toBe(true)
    expect(interrupted).toBe(true)
  } finally { handle.agent.cancel({ kind: 'disposed' }); await handle.dispose() }
})

it('keeps ordinary user cancellation distinct from interjection', async () => {
  const { ctx, ledger } = await harness()
  contexts.push(ctx)
  const adapter = new InterruptibleAdapter()
  ctx.llm.registerAdapter(['interruptible'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('seat-a'), agentOptions: { provider: 'interruptible', model: 'model-a' } })
  try {
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start' }] }))
    await adapter.entered.promise
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    expect(ledger?.ends[0]?.endReason).toBe('cancelled')
    expect(ledger?.ends[0]?.upstreamStopReason).not.toBe('interjection')
    expect(ledger?.events.filter(event => event.kind === 'cache/break' && event.evidence.breakReasons.includes('interjection'))).toHaveLength(0)
  } finally { handle.agent.cancel({ kind: 'disposed' }); await handle.dispose() }
})

it('records upstream request-prefix reconstruction without renaming existing break reasons', async () => {
  const { ctx, ledger } = await harness()
  contexts.push(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('seat-a'), agentOptions: { provider: 'model-provider', model: 'model-a' } })
  let sequence = 0
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
    ...await next(), sections: [{ name: 'rebuilt', text: ++sequence === 1 ? 'First prefix' : 'Rebuilt prefix', interpolate: false }],
  }), { prepend: true })
  try {
    for (const text of ['Start', 'Continue']) {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await handle.agent.whenIdle()
    }
    expect(ledger?.starts).toHaveLength(2)
    expect(ledger?.starts[0]?.cache.prefixFingerprint).not.toBe(ledger?.starts[1]?.cache.prefixFingerprint)
    expect(ledger?.starts[1]?.cache.breakReasons).toContain('history-edit')
  } finally { await handle.dispose() }
})
