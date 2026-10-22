import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { serviceFixture } from './fixtures/persistence.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { decodeCommand } from '../src/codec.ts'
import { publishedFiles } from '../src/files.ts'

const controls = ['withdraw', 'edit', 'reprioritize', 'invalidate'] as const

describe('control record publication', () => {
  it.each(controls)('rejects missing expectedRevision for %s before publication and keeps draining', async (kind) => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-controls-'))
    const f = await serviceFixture(home)
    try {
      const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'original',
        messageClass: 'handoff', operationId: 'send-a' as OperationId })
      const scheduler = await f.resume()
      const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
      const root = await mailbox.target(f.session.id)
      const before = await publishedFiles(join(root, 'records'))
      const malformed = { messageId: sent.messageId, operationId: 'control-a' as OperationId,
        content: 'updated', priority: 'queue', reason: 'superseded' }
      await expect(Reflect.apply(f.service[kind], f.service, [malformed]))
        .rejects.toThrow(new TypeError(`Invalid messages/${kind} parameters`))
      expect(await publishedFiles(join(root, 'records'))).toEqual(before)
      for (let step = 1; step <= 2; step++) {
        await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step, signal: new AbortController().signal })
      }
      const next = await f.service.send({ target: { sessionId: f.session.id }, content: 'next',
        messageClass: 'handoff', operationId: 'send-b' as OperationId })
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 2, step: 1, signal: new AbortController().signal })
      expect(scheduler.queue.map(message => message.id)).toEqual([sent.messageId, next.messageId])
      expect((await mailbox.snapshot(f.session.id)).records).toHaveLength(2)
    } finally { await f.dispose(); await rm(home, { recursive: true, force: true }) }
  })

  it('rejects malformed send records before publication without poisoning the owner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-controls-'))
    const f = await serviceFixture(home)
    try {
      const scheduler = await f.resume()
      const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
      const request = { target: { sessionId: f.session.id }, content: 'original',
        messageClass: 'handoff', operationId: 'send-a' as OperationId, priority: 'invalid' }
      await expect(Reflect.apply(f.service.send.bind(f.service), f.service, [request]))
        .rejects.toThrow(new TypeError('Invalid messages/send parameters'))
      expect((await mailbox.snapshot(f.session.id)).records).toEqual([])
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step: 1, signal: new AbortController().signal })
      expect(scheduler.queue).toEqual([])
    } finally { await f.dispose(); await rm(home, { recursive: true, force: true }) }
  })

  it.each(controls)('round trips send and %s records and drains twice after the control', async (kind) => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-controls-'))
    const f = await serviceFixture(home)
    try {
      const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'original',
        messageClass: 'handoff', operationId: 'send-a' as OperationId })
      const request = { messageId: sent.messageId, operationId: 'control-a' as OperationId,
        expectedRevision: 0, content: 'updated', priority: 'queue' as const, reason: 'superseded' }
      expect(await f.service[kind](request)).toMatchObject({ kind: 'accepted-pending-owner' })
      const scheduler = await f.resume()
      const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
      const commands = (await mailbox.snapshot(f.session.id)).records.map(record => decodeCommand(record.value))
      expect(commands.map(command => command.kind)).toEqual(['send', kind])
      for (const command of commands) expect(decodeCommand(decodeCommand(command, 'request'))).toEqual(command)
      for (let step = 1; step <= 2; step++) {
        await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step, signal: new AbortController().signal })
      }
      const state = kind === 'withdraw' || kind === 'invalidate' ? 'withdrawn' : 'queued'
      expect((await f.service.status(sent.messageId)).state).toBe(state)
      expect((await f.ledger.read()).events.some(event => event.kind === 'message/state' && event.data.messageId === sent.messageId
        && event.data.transition === (kind === 'edit' ? 'edited' : kind === 'reprioritize' ? 'reprioritized' : 'withdrawn'))).toBe(true)
    } finally { await f.dispose(); await rm(home, { recursive: true, force: true }) }
  })
})
