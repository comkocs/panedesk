import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { digest } from '@panedesk/dsh-host-admin'
import { decodeRoutedSeatSend, type NodeLinkStatus } from '@panedesk/dsh-node-link'
import type { MessageReason, MessageRecipient, NodeId, RoutedDeliveryAuthority } from '@panedesk/dsh-message-delivery'
import { FileMailbox } from '../src/mailbox.ts'
import { createSeatMessageReceiver } from '../src/seat-receiver.ts'
import { observeRemoteSeats } from '../src/seat-observations.ts'
import { sendRoutedMessage } from '../src/routed-sender.ts'
import { publish } from '../src/files.ts'

function request(sourceNodeId = 'node-a') {
  const target = { nodeId: 'node-b', seat: 'receiver' }
  const envelope = { deliveryId: 'delivery-a', sourceNodeId, message: {
    messageId: 'message-a', operationId: 'operation-a', sender: { kind: 'session', sessionId: 'sender-a' },
    senderSessionId: 'sender-a', target, content: 'original text', messageClass: 'handoff', priority: 'steer',
    createdAt: 123, revision: 0, mailboxSequence: 0, stateVersion: 0 } }
  return decodeRoutedSeatSend({ target, operationId: 'operation-a', content: 'original text', messageClass: 'handoff',
    delivery: { ...envelope, digest: digest(envelope) } })
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'seat-message-'))
  const mailbox = new FileMailbox({ home, nodeId: 'node-b', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  const input = request()
  const authority = { sourceNodeId: input.delivery.sourceNodeId, targetNodeId: input.target.nodeId } as RoutedDeliveryAuthority
  const recipient: MessageRecipient = { nodeId: input.target.nodeId, sessionId: SessionId('target-b'), title: null,
    window: null, status: 'idle', observedAt: Date.now(), matchedFields: ['sessionId'] }
  let permitted = true
  let refusal: MessageReason | undefined
  let notifications = 0
  const receiver = createSeatMessageReceiver({ mailbox, maxContentBytes: 4096,
    authorize: async value => permitted && value === authority,
    resolve: async () => refusal ?? recipient, notify: () => { notifications++ }, online: async () => [] })
  return { mailbox, input, authority, receiver, recipient,
    refuse(reason: MessageReason) { refusal = reason }, revoke() { permitted = false }, notifications: () => notifications,
    close: () => rm(home, { recursive: true, force: true }) }
}
describe('two-node original seat delivery', () => {
  it('reconciles an uncertain send with its original key and frozen envelope', async () => {
    const f = await fixture(), ctx = new Context()
    const home = await mkdtemp(join(tmpdir(), 'seat-sender-'))
    const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    let calls = 0
    let original: object | undefined
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 10000, maxClockSkewMs: 0 }, issue: async prepared => ({
      status: 'issued', delegation: { kind: 'node-delegation', hop: 1, taskIds: [],
        authorizationRef: 'authority' as import('@panedesk/dsh-node-link').NodeWireRequest['delegation']['authorizationRef'],
        principalId: 'principal' as import('@panedesk/dsh-node-link').NodeWireRequest['delegation']['principalId'],
        sessionId: SessionId('sender-a'), sourceNodeId: prepared.sourceNodeId, targetNodeId: prepared.targetNodeId,
        operationId: prepared.operationId, requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline } }) })
    ctx.provide('nodeRouter', { status: async () => [], route: async (wire, recovery) => {
      calls++
      expect(wire.method).toBe('messages.sendSeat')
      if (calls === 1) {
        original = wire.payload
        return { ...wire, status: 'uncertain', error: { code: 'node-outcome-unknown', reason: 'Response lost',
          effectState: 'unknown', retryable: true, operationId: wire.operationId, targetNodeId: wire.targetNodeId } }
      }
      expect(recovery?.reconcile).toBe(true)
      expect(wire.payload).toEqual(original)
      if (wire.method !== 'messages.sendSeat') throw new Error('Unexpected method')
      return { ...wire, status: 'ok', result: await f.receiver.receive(wire.payload, f.authority) }
    } })
    try {
      const { delivery, ...input } = f.input
      expect(await sendRoutedMessage(ctx, mailbox, input, delivery.message.sender)).toMatchObject({ reason: 'delivery-uncertain' })
      expect(await sendRoutedMessage(ctx, mailbox, input, delivery.message.sender)).toMatchObject({ deliveryOutcome: 'accepted' })
      expect(await sendRoutedMessage(ctx, mailbox, input, delivery.message.sender)).toMatchObject({ deliveryOutcome: 'accepted' })
      expect(calls).toBe(2)
      expect((await f.mailbox.snapshot('target-b')).records).toHaveLength(1)
    } finally { await ctx.fiber.dispose(); await f.close(); await rm(home, { recursive: true, force: true }) }
  })
  it('delivers once to the resolved top-level window and retains sender identity on replay', async () => {
    const f = await fixture()
    try {
      const first = await f.receiver.receive(f.input, f.authority)
      expect(first).toMatchObject({ deliveryOutcome: 'accepted', messageId: 'message-a', operationId: 'operation-a' })
      expect(await f.receiver.receive(f.input, f.authority)).toEqual(first)
      const records = (await f.mailbox.snapshot('target-b')).records
      expect(records).toHaveLength(1)
      expect(records[0]?.value).toMatchObject({ message: { messageId: 'message-a', senderSessionId: 'sender-a',
        sender: { kind: 'session', sessionId: 'sender-a' }, target: { nodeId: 'node-b', sessionId: 'target-b' }, createdAt: 123 } })
      expect(f.notifications()).toBe(1)
      f.revoke()
      expect(await f.receiver.receive(f.input, f.authority)).toMatchObject({ reason: 'unauthorized' })
    } finally { await f.close() }
  })
  it.each(['target-not-found', 'offline', 'busy-not-accepting'] as const)('preserves %s without a mailbox effect', async (reason) => {
    const f = await fixture()
    try {
      f.refuse(reason)
      expect(await f.receiver.receive(f.input, f.authority)).toMatchObject({ deliveryOutcome: 'rejected', reason, pending: false, candidates: [] })
      expect((await f.mailbox.snapshot('target-b')).records).toHaveLength(0)
      expect(f.notifications()).toBe(0)
    } finally { await f.close() }
  })
  it('keeps a pinned but uncommitted delivery unknown when the original window stops accepting', async () => {
    const f = await fixture()
    try {
      const message = f.input.delivery.message
      for (const [index, id] of [f.input.delivery.deliveryId, message.messageId, message.operationId].entries()) {
        await publish(join(f.mailbox.root, 'operations', `routed-${index}-${digest([f.input.delivery.sourceNodeId, id])}.json`),
          { digest: f.input.delivery.digest, delivery: f.input.delivery, recipient: f.recipient }, 1048576)
      }
      f.refuse('offline')
      await expect(f.receiver.receive(f.input, f.authority)).rejects.toThrow('requires reconciliation')
      expect((await f.mailbox.snapshot('target-b')).records).toHaveLength(0)
    } finally { await f.close() }
  })
  it('refuses an unauthorized source and a forged body source', async () => {
    const f = await fixture()
    try {
      expect(await f.receiver.receive(f.input, { ...f.authority })).toMatchObject({ reason: 'unauthorized' })
      expect(await f.receiver.receive(request('forged-source'), f.authority)).toMatchObject({ reason: 'unauthorized' })
      expect((await f.mailbox.snapshot('target-b')).records).toHaveLength(0)
    } finally { await f.close() }
  })
  it('shows unknown state for an unreachable node without querying or inventing an empty list', async () => {
    const ctx = new Context()
    const state: NodeLinkStatus = { nodeId: 'node-b' as NodeLinkStatus['nodeId'], nodeName: 'peer', reachable: false,
      linkState: 'disconnected', observedAt: new Date().toISOString(), status: null, capabilities: [], safeReason: null }
    ctx.provide('nodeRouter', { status: async () => [state], route: async () => { throw new Error('Offline query must not dispatch') } })
    try {
      expect(await observeRemoteSeats(ctx, 'node-a' as NodeId, 2, new AbortController().signal)).toEqual([{ nodeId: 'node-b', state: 'unknown', reason: 'unavailable' }])
    } finally { await ctx.fiber.dispose() }
  })
})
