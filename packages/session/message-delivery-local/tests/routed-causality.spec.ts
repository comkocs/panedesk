/** Ordinary routed sends refuse caller-defined causality before issuing or routing. */
import { expect, test, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SendMessageRequest } from '@panedesk/dsh-message-delivery'
import { FileMailbox } from '../src/mailbox.ts'
import { sendRoutedMessage } from '../src/routed-sender.ts'

test.each(['callId', 'rootCallId', 'causedByDeliveryId', 'delivery'])('rejects self-declared %s without route dispatch', async (key) => {
  const home = await mkdtemp(join(tmpdir(), 'causality-refusal-'))
  const ctx = new Context()
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    const route = vi.fn(async () => { throw new Error('Untrusted causality reached transport') })
    const issue = vi.fn(async () => { throw new Error('Untrusted causality reached issuer') })
    ctx.provide('nodeRouter', { route, status: async () => [] })
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, issue })
    const input: SendMessageRequest = { operationId: 'send-a' as SendMessageRequest['operationId'],
      target: { nodeId: 'node-b' as NonNullable<SendMessageRequest['target']['nodeId']>,
        sessionId: 'session-b' as NonNullable<SendMessageRequest['target']['sessionId']> }, messageClass: 'handoff', content: 'handoff' }
    expect(await sendRoutedMessage(ctx, mailbox, { ...input, [key]: 'self-declared' }, { kind: 'human', sessionId: null }))
      .toMatchObject({ deliveryOutcome: 'rejected', reason: 'unauthorized' })
    expect(issue).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
