import { expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { wakeupFixture } from './fixtures/wakeup.ts'

it('ends the requesting turn and wakes on reply without a sleep tool', async () => {
  const f = await wakeupFixture(false)
  try {
    const other = f.ctx.sessions.create(SessionId('seat-b'))
    await (await f.ctx.sessionPersistence.create(other.header)).close()
    const responder = await f.resume(other)
    const toolCalls: string[] = []
    const stop = f.ctx.on('session/event', (session, event) => {
      if (session === f.session && event.type === 'tool/call') toolCalls.push(`${event.data.name} ${event.data.arguments}`)
    })
    f.session.append('turn/start', { turn: 10 })
    const question = await f.ctx.agents.withInitiator(f.scheduler.agent, () => f.service.send({
      target: { sessionId: other.id }, content: 'Review this item', messageClass: 'handoff', operationId: 'question' as OperationId,
    }))
    f.session.append('turn/end', { turn: 10, reason: { kind: 'completed' } })
    await f.ctx.serial('agent/input-preparing', { agent: responder.agent, turn: 1, step: 1, signal: new AbortController().signal })
    const reply = await f.ctx.agents.withInitiator(responder.agent, () => f.service.send({
      target: { sessionId: f.session.id }, content: 'Approved', messageClass: 'reply', replyTo: question.messageId, operationId: 'reply' as OperationId,
    }))
    const started = await f.started(reply.messageId)
    const persisted = f.persisted.get(reply.messageId)
    if (persisted === undefined) throw new Error('Reply durability sample unavailable')
    const sleepToolCalls = toolCalls.filter(call => /\b(sleep|wait|timeout)\b/i.test(call)).length
    expect(sleepToolCalls).toBe(0)
    expect(started - persisted).toBeGreaterThanOrEqual(0)
    expect(started - persisted).toBeLessThanOrEqual(5000)
    expect(f.scheduler.queue.find(item => item.id === reply.messageId)?.source).toMatchObject({ messageClass: 'reply', replyTo: question.messageId })
    process.stdout.write(JSON.stringify({ sleepToolCalls, toolCalls, replyMaxMs: started - persisted,
      clock: 'performance.now', measuredAt: performance.now() }) + '\n')
    stop()
  } finally { await f.dispose() }
})
