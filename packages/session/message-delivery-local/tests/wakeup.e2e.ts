import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { DeliveryMessage, NodeId, OperationId } from '@panedesk/dsh-message-delivery'
import { FileMailbox } from '../src/mailbox.ts'
import { wakeupFixture } from './fixtures/wakeup.ts'

describe('idle wake latency through a substitute driver', () => {
  it.each(['watch-normal', 'watch-lost', 'already-idle', 'reply'] as const)('%s measures durable send to target turn/start', async (scenario) => {
    const f = await wakeupFixture(scenario === 'watch-normal')
    try {
      const samples: number[] = []
      const original = await f.service.send({ target: { sessionId: f.session.id }, content: 'original', messageClass: 'notice', operationId: 'original' as OperationId })
      await f.drain()
      for (let index = 0; index < 3; index++) {
        const operationId = `send-${index}` as OperationId
        let messageId
        if (scenario === 'watch-normal' || scenario === 'watch-lost') {
          const input = createUserMessage({ content: [{ type: 'text', text: 'handoff' }], source: { kind: 'user' } })
          const message: DeliveryMessage = { messageId: input.id, sender: { kind: 'human', sessionId: null }, senderSessionId: null,
            target: { nodeId: 'node-a' as NodeId, sessionId: f.session.id }, messageClass: 'handoff', priority: 'steer',
            content: 'handoff', createdAt: Date.now(), revision: 0, operationId, mailboxSequence: 0, stateVersion: 0 }
          const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
          await mailbox.append(f.session.id, operationId, operationId, { kind: 'send', message, result: {
            messageId: input.id, operationId, deliveryOutcome: 'accepted', messageState: 'queued', pending: false,
            recipient: { nodeId: 'node-a', sessionId: f.session.id, window: null, title: null, status: 'idle', matchedFields: ['sessionId'], observedAt: Date.now() },
          } })
          messageId = input.id
        } else {
          const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'handoff', operationId,
            ...(scenario === 'reply' ? { messageClass: 'reply', replyTo: original.messageId } : { messageClass: 'handoff' }) })
          messageId = sent.messageId
        }
        const started = await f.started(messageId)
        const persisted = f.persisted.get(messageId)
        expect(persisted).toBeDefined()
        if (persisted === undefined) throw new Error('Durability sample unavailable')
        const elapsed = started - persisted
        expect(elapsed).toBeGreaterThanOrEqual(0)
        expect(elapsed).toBeLessThanOrEqual(5000)
        samples.push(elapsed)
        f.session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
      }
      process.stdout.write(JSON.stringify({ scenario, clock: 'performance.now', samples, maxMs: Math.max(...samples) }) + '\n')
    } finally { await f.dispose() }
  })
})
