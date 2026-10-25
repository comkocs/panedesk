/** Routed refusal diagnostics survive durable decoding without altering legacy results. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SendMessageRequest } from '@panedesk/dsh-message-delivery'
import { decodeRoutedSend, type NodeLinkFailure, type NodeWireRequest, type NodeWireResponse } from '@panedesk/dsh-node-link'
import { digest } from '@panedesk/dsh-host-admin'
import { decodeSendResult } from '../src/codec.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { sendRoutedMessage } from '../src/routed-sender.ts'
import { publish, readValue } from '../src/files.ts'

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

test.each(['issuer', 'transport', 'result'] as const)('retains %s refusal diagnostics through file publication and replay', async (stage) => {
  const home = await mkdtemp(join(tmpdir(), 'routed-cause-'))
  const ctx = new Context()
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'source', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    const input: SendMessageRequest = { operationId: 'operation' as SendMessageRequest['operationId'],
      target: { nodeId: 'target' as NonNullable<SendMessageRequest['target']['nodeId']>,
        sessionId: 'session' as NonNullable<SendMessageRequest['target']['sessionId']> }, messageClass: 'handoff', content: 'handoff' }
    const error: NodeLinkFailure = { code: 'node-delegation-rejected', reason: 'Original authority was revoked.',
      retryable: false, effectState: 'none', operationId: 'operation' as NodeLinkFailure['operationId'],
      targetNodeId: 'target' as NodeLinkFailure['targetNodeId'] }
    let calls = 0
    const route = async (wire: NodeWireRequest): Promise<NodeWireResponse> => {
      calls++
      if (stage === 'issuer' || wire.method !== 'messages.send') throw new Error('Unexpected route dispatch')
      if (stage === 'transport') return { ...wire, status: 'uncertain', error: { ...error,
        code: 'node-outcome-unknown', effectState: 'unknown' } }
      const payload = decodeRoutedSend(wire.payload)
      return { ...wire, status: 'ok', result: decodeSendResult({ ...result,
        messageId: payload.delivery.message.messageId, cause }) }
    }
    ctx.provide('nodeRouter', { route, status: async () => [] })
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      issue: async prepared => stage === 'issuer' ? { status: 'rejected', error } : { status: 'issued',
        delegation: { kind: 'node-delegation', taskIds: [],
          authorizationRef: 'authorization' as NodeWireRequest['delegation']['authorizationRef'], sourceNodeId: prepared.sourceNodeId,
          targetNodeId: prepared.targetNodeId, principalId: 'principal' as NodeWireRequest['delegation']['principalId'],
          operationId: prepared.operationId, requestDigest: prepared.payloadDigest,
          expiresAt: prepared.deadline, hop: 1 } } })
    const sender = { kind: 'human', sessionId: null } as const
    const sent = await sendRoutedMessage(ctx, mailbox, input, sender)
    expect(sent).toMatchObject({ reason: stage === 'issuer' ? 'unauthorized' : 'delivery-uncertain',
      cause: { domain: 'node-link', code: stage === 'issuer' ? error.code : 'node-outcome-unknown',
        effectState: stage === 'issuer' ? 'none' : 'unknown', operationId: 'operation', nodeId: 'target' } })
    if (stage === 'result') {
      expect(await sendRoutedMessage(ctx, mailbox, input, sender)).toEqual(sent)
      expect(calls).toBe(1)
      const stored = await readValue(join(mailbox.root, 'operations', 'operation.json'), 1048576)
      expect(stored).toMatchObject({ digest: digest({ sender, request: input }), result: sent })
    }
    const path = join(home, 'retained-result.json')
    await publish(path, sent, 1048576)
    expect(decodeSendResult(await readValue(path, 1048576))).toEqual(sent)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
