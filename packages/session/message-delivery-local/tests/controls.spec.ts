import { afterEach, describe, expect, it } from 'vitest'
import type { NodeId, OperationId } from '@panedesk/dsh-message-delivery'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@panedesk/dsh-session'
import type { InputClaimId, InputTransition } from '@panedesk/dsh-agent/types'
import type { MessageId } from '@panedesk/dsh-llm'
import { ownerFixture } from './fixtures/owner.ts'
import { serviceFixture } from './fixtures/persistence.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { decodeCommand } from '../src/codec.ts'

const fixtures: Awaited<ReturnType<typeof ownerFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(item => item.dispose())) })
async function setup() { const fixture = await ownerFixture(); fixtures.push(fixture); return fixture }

describe('owner arbitration', () => {
  it('persists sends before receipts, retains identity on resume, and commits ledger events before notifications', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-ledger-'))
    const f = await serviceFixture(home)
    try {
      const request = { target: { sessionId: f.session.id }, content: 'original', messageClass: 'handoff' as const, operationId: 'send-a' as OperationId }
      const sent = await f.service.send(request)
      const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
      const records = (await mailbox.snapshot(f.session.id)).records
      expect(records).toHaveLength(1)
      expect(decodeCommand(records[0]?.value)).toMatchObject({ kind: 'send', message: { messageId: sent.messageId, content: 'original' } })
      expect(await f.service.send(request)).toEqual(sent)
      await expect(f.service.send({ ...request, content: 'different' })).rejects.toThrow('operation-conflict')
      expect(await f.service.send({ ...request, operationId: 'bad-reply' as OperationId, messageClass: 'reply', replyTo: 'missing' as MessageId }))
        .toMatchObject({ reason: 'invalid-reply', messageState: 'rejected' })
      expect((await mailbox.snapshot(f.session.id)).records).toHaveLength(1)
      const reply = await f.service.send({ ...request, operationId: 'reply-a' as OperationId, messageClass: 'reply', replyTo: sent.messageId })
      expect(reply.messageState).toBe('queued')
      const scheduler = await f.resume()
      expect(scheduler.queue[0]?.id).toBe(sent.messageId)
      expect(scheduler.queue[1]).toMatchObject({ id: reply.messageId, source: { messageClass: 'reply', replyTo: sent.messageId } })
      const edited = await f.service.edit({ messageId: sent.messageId, content: 'updated', operationId: 'edit-a' as OperationId, expectedRevision: 0 })
      expect(edited).toMatchObject({ kind: 'applied', status: { state: 'queued', phase: 'pending' } })
      expect((await f.service.status(sent.messageId)).transitions.some(event => event.data.transition === 'injected')).toBe(false)
      scheduler.queue.splice(0, 1)
      const base = { claimId: 'claim-a' as InputClaimId, messageIds: [sent.messageId], turn: 1, step: 1 }
      f.session.append('agent/input/transition', { ...base, phase: 'claimed' })
      f.session.append('agent/input/transition', { ...base, phase: 'appended', userEventSeqs: [] })
      f.session.append('agent/input/transition', { ...base, phase: 'dispatched', requestId: 'request-a' as Extract<InputTransition, { phase: 'dispatched' }>['requestId'] })
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step: 1, signal: new AbortController().signal })
      expect((await f.service.status(sent.messageId)).state).toBe('injected')
      await f.service.invalidate({ messageId: sent.messageId, reason: 'superseded', operationId: 'invalidate-a' as OperationId, expectedRevision: 1 })
      const expected = ['accepted', 'edited', 'claimed', 'appended', 'injected', 'invalidated']
      const recorded = (await f.ledger.read()).events.filter(event => event.data.messageId === sent.messageId)
      expect(recorded.map(event => event.data.transition)).toEqual(expected)
      expect(f.emitted.filter(event => event.data.messageId === sent.messageId).map(event => event.data.transition)).toEqual(expected)
      const accepted = await f.service.send({ ...request, operationId: 'live-a' as OperationId })
      expect(accepted).toMatchObject({ deliveryOutcome: 'accepted', messageState: 'queued' })
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 2, step: 1, signal: new AbortController().signal })
      expect((await f.service.status(accepted.messageId)).state).toBe('queued')
      expect(await f.service.resolve([{ nodeId: 'other-node' as NodeId, sessionId: SessionId('seat-a') }]))
        .toMatchObject([{ reason: 'cross-node-unsupported' }])
    } finally { await f.dispose(); await rm(home, { recursive: true, force: true }) }
  })
  it('applies offline withdrawal before admitting a resumed send', async () => {
    const f = await setup()
    await f.send()
    await f.control({ kind: 'withdraw', operationId: 'withdraw-a' as OperationId, expectedRevision: 0 })
    expect(f.queue).toEqual([])
    await f.arbitrator.drain()
    expect(f.queue).toEqual([])
    expect((await f.status()).status.state).toBe('withdrawn')
    expect((await f.result('withdraw-a')).kind).toBe('applied')
  })

  it('edits in place and moves a reprioritized item to the new FIFO tail', async () => {
    const f = await setup()
    await f.send()
    await f.arbitrator.drain()
    await f.control({ kind: 'edit', operationId: 'edit-a' as OperationId, expectedRevision: 0 }, { content: 'updated' })
    await f.arbitrator.drain()
    expect(f.queue[0]).toMatchObject({ id: f.message.messageId, content: [{ type: 'text', text: 'updated' }] })
    await f.control({ kind: 'reprioritize', operationId: 'priority-a' as OperationId, expectedRevision: 1 }, { priority: 'immediate' })
    await f.arbitrator.drain()
    expect(f.options.get(f.message.messageId)?.priority).toBe('immediate')
    expect((await f.status()).status.revision).toBe(2)
  })

  it('replays a committed control after the separate receipt is lost', async () => {
    const f = await setup()
    await f.send()
    await f.control({ kind: 'edit', operationId: 'edit-a' as OperationId, expectedRevision: 0 }, { content: 'updated' })
    await f.arbitrator.drain()
    await f.removeReceipt('edit-a')
    await f.restart()
    expect((await f.result('edit-a')).kind).toBe('applied')
    expect((await f.status()).status.revision).toBe(1)
    expect(f.queue).toHaveLength(1)
  })

  it('rejects stale revisions and foreign senders without changing pending input', async () => {
    const f = await setup()
    await f.send()
    await f.arbitrator.drain()
    await f.control({ kind: 'withdraw', operationId: 'stale-a' as OperationId, expectedRevision: 1 })
    await f.control({ kind: 'withdraw', operationId: 'foreign-a' as OperationId, expectedRevision: 0 },
      { sender: { kind: 'session', sessionId: 'seat-b' } })
    await f.arbitrator.drain()
    expect(await f.result('stale-a')).toMatchObject({ kind: 'rejected', reason: 'revision-conflict' })
    expect(await f.result('foreign-a')).toMatchObject({ kind: 'rejected', reason: 'unauthorized' })
    expect(f.queue).toHaveLength(1)
  })
})
