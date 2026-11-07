/** Routed refusal diagnostics survive durable decoding without altering legacy results. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SendMessageRequest } from '@panedesk/dsh-message-delivery'
import { decodeRoutedSend } from '@panedesk/dsh-node-link'
import { digest } from '@panedesk/dsh-host-admin'
import { decodeSendResult } from '../src/codec.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { sendRoutedMessage, recoverRoutedMessages, type RoutedRecoveryScan } from '../src/routed-sender.ts'
import { publish } from '../src/files.ts'

const result = { messageId: 'message', operationId: 'operation', deliveryOutcome: 'rejected',
  messageState: 'rejected', pending: false, reason: 'delivery-uncertain', candidates: [] }
const cause = { domain: 'node-link', code: 'node-outcome-unknown', reason: 'Remote outcome is unknown.',
  effectState: 'unknown', retryable: true, operationId: 'operation', nodeId: 'target', reasonCode: 'outcome-unknown' }

test('preserves every optional cause field and leaves legacy results unchanged', () => {
  expect(decodeSendResult(result)).toEqual(result)
  expect(decodeSendResult(result)).not.toHaveProperty('cause')
  expect(decodeSendResult({ ...result, cause })).toEqual({ ...result, cause })
  expect(decodeSendResult({ ...result, cause: { ...cause, reason: 'é'.repeat(256), code: 'a'.repeat(128) } }))
    .toHaveProperty('cause.effectState', 'unknown')
})

test.each([
  { domain: '' }, { code: 'a'.repeat(129) }, { code: 'unsafe code' }, { reason: 'é'.repeat(257) },
  { reason: 'unsafe\nreason' }, { reason: ' ' }, { effectState: 'other' }, { retryable: 'true' },
  { operationId: '' }, { nodeId: '' }, { reasonCode: 'bad code' }, { reasonCode: 'unregistered' }, { extra: true },
])('rejects invalid durable refusal fields: %j', (invalid) => {
  expect(() => decodeSendResult({ ...result, cause: { ...cause, ...invalid } })).toThrow('Invalid durable mailbox evidence')
})

test('retains a pre-send transport refusal as terminal when the same operation is retried', async () => {
  const home = await mkdtemp(join(tmpdir(), 'routed-terminal-')), ctx = new Context()
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'source', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    const request: SendMessageRequest = { operationId: 'terminal' as SendMessageRequest['operationId'],
      target: { nodeId: 'target' as NonNullable<SendMessageRequest['target']['nodeId']>,
        sessionId: 'session' as NonNullable<SendMessageRequest['target']['sessionId']> }, messageClass: 'handoff', content: 'Synthetic message' }
    let calls = 0
    ctx.provide('nodeRouter', { status: async () => [], route: async (wire) => {
      calls++
      return { ...wire, status: 'unavailable', error: { code: 'node-tunnel-disconnected', reason: 'node-tunnel-disconnected',
        effectState: 'none', retryable: true, operationId: wire.operationId, targetNodeId: wire.targetNodeId } }
    } })
    const sender = { kind: 'human', sessionId: null } as const
    const first = await sendRoutedMessage(ctx, mailbox, request, sender)
    expect(first).toMatchObject({ reason: 'unavailable', cause: { effectState: 'none' } })
    expect(await sendRoutedMessage(ctx, mailbox, request, sender)).toEqual(first)
    expect(calls).toBe(1)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('bounds and fairly continues recovery past terminal and malformed records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'routed-scan-')), ctx = new Context()
  const scan: RoutedRecoveryScan = { maxEntries: 1 }
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'source', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    ctx.provide('nodeRouter', { status: async () => [], route: async () => { throw new Error('Unexpected dispatch') } })
    const directory = join(mailbox.root, 'operations')
    await publish(join(directory, 'terminal.json'), { result }, 1048576)
    await writeFile(join(directory, 'malformed.json'), '{')
    const payload = { operationId: 'scan', target: { nodeId: 'target', sessionId: 'target-session' },
      messageClass: 'handoff', content: 'Synthetic bounded scan', delivery: { deliveryId: 'scan-delivery', sourceNodeId: 'source',
        digest: 'retained', message: { messageId: 'scan-message', operationId: 'scan',
          sender: { kind: 'human', sessionId: null }, senderSessionId: null, target: { nodeId: 'target', sessionId: 'target-session' },
          priority: 'steer', content: 'Synthetic bounded scan', createdAt: 1, revision: 0, mailboxSequence: 0, stateVersion: 0,
          messageClass: 'handoff' } } }
    const { digest: retainedDigest, ...envelope } = payload.delivery
    void retainedDigest
    const valid = decodeRoutedSend({ ...payload, delivery: { ...envelope, digest: digest(envelope) } })
    await publish(join(directory, 'unknown.json'), { phase: 'unknown', authority: {}, request: valid }, 1048576)
    let passes = 0
    do {
      await recoverRoutedMessages(ctx, mailbox, () => true, scan)
      passes++
      expect(passes).toBeLessThan(10)
    } while (scan.directory !== undefined)
    expect(passes).toBe(4)
  } finally { await scan.directory?.close(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
