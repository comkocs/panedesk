/** Routed refusal diagnostics survive durable decoding without altering legacy results. */
import { expect, test } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SendMessageRequest } from '@panedesk/dsh-message-delivery'
import { decodeRoutedSend, type NodeLinkFailure, type NodeWireRequest, type NodeWireResponse } from '@panedesk/dsh-node-link'
import { digest } from '@panedesk/dsh-host-admin'
import { decodeSendResult } from '../src/codec.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { sendRoutedMessage, recoverRoutedMessages, type RoutedRecoveryScan } from '../src/routed-sender.ts'
import { serviceFixture } from './fixtures/persistence.ts'
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
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, issue: async prepared => ({ status: 'issued',
      delegation: { kind: 'node-delegation', hop: 1, taskIds: [], authorizationRef: 'authorization' as NodeWireRequest['delegation']['authorizationRef'],
        principalId: 'principal' as NodeWireRequest['delegation']['principalId'], sourceNodeId: prepared.sourceNodeId,
        targetNodeId: prepared.targetNodeId, operationId: prepared.operationId,
        requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline } }) })
    const sender = { kind: 'human', sessionId: null } as const
    const first = await sendRoutedMessage(ctx, mailbox, request, sender)
    expect(first).toMatchObject({ reason: 'unavailable', cause: { effectState: 'none' } })
    expect(await sendRoutedMessage(ctx, mailbox, request, sender)).toEqual(first)
    expect(calls).toBe(1)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test.each(['recovered', 'revoked', 'principal-changed', 'stopped', 'stopped-during-issue'] as const)(
  'recovers frozen unknown messages only under live original authority: %s', async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'routed-recovery-')), ctx = new Context()
    const scan: RoutedRecoveryScan = { maxEntries: 100 }
    try {
      const mailbox = new FileMailbox({ home, nodeId: 'source', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
      await mailbox.initialize()
      const request: SendMessageRequest = { operationId: 'recovery' as SendMessageRequest['operationId'],
        target: { nodeId: 'target' as NonNullable<SendMessageRequest['target']['nodeId']>,
          sessionId: 'target-session' as NonNullable<SendMessageRequest['target']['sessionId']> },
        messageClass: 'handoff', content: 'Frozen synthetic message' }
      const sender = { kind: 'session', sessionId: 'sender-session' as NonNullable<SendMessageRequest['target']['sessionId']> } as const
      const wires: NodeWireRequest[] = []
      let recovering = false, active = true, scoped = false
      ctx.provide('nodeRouter', { status: async () => [], route: async (wire) => {
        wires.push(wire)
        if (!recovering) return { ...wire, status: 'uncertain', error: { code: 'node-outcome-unknown',
          reason: 'Remote outcome is unknown.', effectState: 'unknown', retryable: true,
          operationId: wire.operationId, targetNodeId: wire.targetNodeId } }
        expect(scoped).toBe(true)
        const payload = decodeRoutedSend(wire.payload)
        return { ...wire, status: 'ok', result: decodeSendResult({ ...result,
          messageId: payload.delivery.message.messageId, operationId: wire.operationId }) }
      } })
      ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, issue: async (prepared) => {
        if (recovering && mode === 'stopped-during-issue') active = false
        if (recovering && mode === 'revoked') return { status: 'rejected', error: {
          code: 'node-delegation-rejected', reason: 'Original authority was revoked.', effectState: 'none', retryable: false,
          operationId: prepared.operationId, targetNodeId: prepared.targetNodeId } }
        return { status: 'issued', delegation: { kind: 'node-delegation', hop: 1, taskIds: [],
          authorizationRef: 'authorization' as NodeWireRequest['delegation']['authorizationRef'],
          principalId: (recovering && mode === 'principal-changed' ? 'other' : 'principal') as NodeWireRequest['delegation']['principalId'],
          sessionId: sender.sessionId, sourceNodeId: prepared.sourceNodeId, targetNodeId: prepared.targetNodeId,
          operationId: prepared.operationId, requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline } }
      } })
      expect(await sendRoutedMessage(ctx, mailbox, request, sender)).toMatchObject({ reason: 'delivery-uncertain' })
      recovering = true
      active = mode !== 'stopped'
      const recover = () => recoverRoutedMessages(ctx, mailbox, async (retained, work) => {
        expect(retained).toEqual(sender)
        scoped = true
        try { await work() } finally { scoped = false }
        return true
      }, () => active, scan)
      await recover()
      expect(wires).toHaveLength(mode === 'recovered' ? 2 : 1)
      if (mode === 'recovered') {
        expect(wires[1]!.payload).toEqual(wires[0]!.payload)
        expect(wires[1]!.operationId).toBe(wires[0]!.operationId)
        await recover()
        expect(wires).toHaveLength(2)
      } else {
        expect(await readValue(join(mailbox.root, 'operations', 'recovery.json'), 1048576)).toMatchObject({ phase: 'unknown' })
      }
    } finally { await scan.directory?.close(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
  })

test.each(['recovered', 'revoked', 'owner-closed'] as const)(
  'recovers through the Loader-owned service and live original Agent: %s', async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'routed-loader-'))
    const fixture = await serviceFixture(home)
    try {
      const { ctx, service, session } = fixture
      const owner = await fixture.resume()
      const wires: NodeWireRequest[] = []
      let recovering = false, recoveryIssues = 0
      const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
      ctx.provide('nodeRouter', { status: async () => [], route: async (wire) => {
        wires.push(wire)
        if (!recovering) return { ...wire, status: 'uncertain', error: { code: 'node-outcome-unknown',
          reason: 'Remote outcome is unknown.', effectState: 'unknown', retryable: true,
          operationId: wire.operationId, targetNodeId: wire.targetNodeId } }
        expect(ctx.agents.currentInitiator()).toBe(owner.agent)
        const payload = decodeRoutedSend(wire.payload)
        return { ...wire, status: 'ok', result: decodeSendResult({ ...result,
          messageId: payload.delivery.message.messageId, operationId: wire.operationId }) }
      } })
      ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 }, issue: async (prepared) => {
        expect(ctx.agents.currentInitiator()).toBe(owner.agent)
        if (recovering) {
          recoveryIssues++
          entered.resolve(undefined)
          if (mode === 'owner-closed') await release.promise
          if (mode === 'revoked') return { status: 'rejected', error: { code: 'node-delegation-rejected',
            reason: 'Original authority was revoked.', effectState: 'none', retryable: false,
            operationId: prepared.operationId, targetNodeId: prepared.targetNodeId } }
        }
        return { status: 'issued', delegation: { kind: 'node-delegation', hop: 1, taskIds: [],
          authorizationRef: 'authorization' as NodeWireRequest['delegation']['authorizationRef'],
          principalId: 'principal' as NodeWireRequest['delegation']['principalId'], sessionId: session.id,
          sourceNodeId: prepared.sourceNodeId, targetNodeId: prepared.targetNodeId,
          operationId: prepared.operationId, requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline } }
      } })
      const request: SendMessageRequest = { operationId: 'loader-recovery' as SendMessageRequest['operationId'],
        target: { nodeId: 'target' as NonNullable<SendMessageRequest['target']['nodeId']>, sessionId: session.id },
        messageClass: 'handoff', content: 'Synthetic Loader recovery' }
      expect(await ctx.agents.withInitiator(owner.agent, () => service.send(request))).toMatchObject({ reason: 'delivery-uncertain' })
      recovering = true
      if (mode === 'owner-closed') {
        await entered.promise
        await owner.close()
        release.resolve(undefined)
      }
      await expect.poll(() => recoveryIssues).toBeGreaterThan(0)
      if (mode === 'recovered') {
        await expect.poll(() => wires.length).toBe(2)
        expect(wires[1]!.payload).toEqual(wires[0]!.payload)
        expect(wires[1]!.operationId).toBe(wires[0]!.operationId)
      }
      await fixture.dispose()
      expect(wires).toHaveLength(mode === 'recovered' ? 2 : 1)
    } finally { await fixture.dispose(); await rm(home, { recursive: true, force: true }) }
  })

test('bounds and fairly continues recovery past terminal and malformed records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'routed-scan-')), ctx = new Context()
  const scan: RoutedRecoveryScan = { maxEntries: 1 }
  try {
    const mailbox = new FileMailbox({ home, nodeId: 'source', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    await mailbox.initialize()
    ctx.provide('nodeRouter', { status: async () => [], route: async () => { throw new Error('Unexpected dispatch') } })
    ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 0 },
      issue: async () => { throw new Error('Unexpected issue') } })
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
    let calls = 0, passes = 0
    do {
      const previous = calls
      await recoverRoutedMessages(ctx, mailbox, async () => { calls++; return false }, () => true, scan)
      expect(calls - previous).toBeLessThanOrEqual(1)
      passes++
      expect(passes).toBeLessThan(10)
    } while (scan.directory !== undefined)
    expect(calls).toBe(1)
    expect(passes).toBe(4)
  } finally { await scan.directory?.close(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
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
