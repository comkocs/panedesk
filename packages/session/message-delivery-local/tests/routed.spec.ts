/** Routed admission preserves complete identity and acknowledges only durable mailbox records. */
import { expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest } from '@panedesk/dsh-host-admin'
import type { RoutedDeliveryAuthority, MessageRecipient } from '@panedesk/dsh-message-delivery'
import { decodeRoutedSend } from '@panedesk/dsh-node-link/src/routed-codec.ts'
import { createRoutedMailboxReceiver } from '../src/routed-receiver.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { readValue } from '../src/files.ts'

function request(content = 'handoff', operationId = 'operation-a', messageId = 'message-a', deliveryId = 'delivery-a') {
  const target = { nodeId: 'node-b', sessionId: 'session-b' }
  const envelope = { deliveryId, sourceNodeId: 'node-a', callId: 'call-a', rootCallId: 'root-a', causedByDeliveryId: 'cause-a',
    message: { messageId, operationId, sender: { kind: 'session', sessionId: 'session-a' }, senderSessionId: 'session-a',
      target, priority: 'steer', content, createdAt: 123, revision: 0, mailboxSequence: 0, stateVersion: 0, messageClass: 'handoff' } }
  return decodeRoutedSend({ operationId, target, content, messageClass: 'handoff', delivery: { ...envelope, digest: digest(envelope) } })
}

test('retains causal identity, returns the original ack after restart and rejects every reused identity with another digest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'routed-mailbox-'))
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'node-b', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    const input = request()
    // Only the test authorization owner may accept this process-local capability double.
    const authority = { sourceNodeId: input.delivery.sourceNodeId,
      targetNodeId: input.delivery.message.target.nodeId } as RoutedDeliveryAuthority
    const recipient: MessageRecipient = { ...input.delivery.message.target, title: 'recipient', status: 'idle',
      window: null, matchedFields: ['sessionId'], observedAt: Date.now() }
    const options = { mailbox, maxContentBytes: 4096,
      authorize: async (value: RoutedDeliveryAuthority) => value === authority,
      resolve: async () => recipient, notify: () => {} }
    const receiver = createRoutedMailboxReceiver(options)
    const ack = await receiver.receive(input, authority)
    expect(ack).toMatchObject({ messageId: 'message-a', operationId: 'operation-a', deliveryOutcome: 'accepted' })
    expect((await mailbox.snapshot('session-b')).records).toHaveLength(1)
    expect(await createRoutedMailboxReceiver(options).receive(input, authority)).toEqual(ack)
    const stored = await readValue(join(mailbox.root, 'operations', `routed-0-${digest(['node-a', 'delivery-a'])}.json`), 1048576)
    expect(stored).toMatchObject({ delivery: input.delivery, result: ack })
    for (const conflict of [request('changed'), request('changed', 'operation-b', 'message-b'),
      request('changed', 'operation-b', 'message-a', 'delivery-b'), request('changed', 'operation-a', 'message-b', 'delivery-b')]) {
      expect(await receiver.receive(conflict, authority)).toMatchObject({ reason: 'operation-conflict' })
    }
    expect(await receiver.receive(input, { ...authority })).toMatchObject({ reason: 'unauthorized' })
    expect((await mailbox.snapshot('session-b')).records).toHaveLength(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('rejects mismatched legacy content and causal digest rather than replacing sender identities', () => {
  const input = request()
  expect(() => decodeRoutedSend({ ...input, content: 'different' })).toThrow()
  expect(() => decodeRoutedSend({ ...input, delivery: { ...input.delivery, callId: 'different' } })).toThrow()
  expect(() => decodeRoutedSend({ ...input, delivery: undefined })).toThrow()
})
