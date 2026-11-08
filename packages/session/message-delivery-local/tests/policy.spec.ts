import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessIdentity } from '@panedesk/dsh-subprocess'
import { FileMailbox } from '../src/mailbox.ts'
import { NodeRegistry } from '../src/registry.ts'
import { validateAcl } from '../src/windows-permissions.ts'
import type { MessageSettings, OperationId } from '@panedesk/dsh-message-delivery'
import { Session, SessionId } from '@panedesk/dsh-session'
import { serviceFixture } from './fixtures/persistence.ts'
import { vi } from 'vitest'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function registry() {
  const home = await mkdtemp(join(tmpdir(), 'registry-'))
  homes.push(home)
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 65536, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  const identity: SubprocessIdentity = { pid: process.pid, startIdentity: '100', bootIdentity: 'boot-a' }
  const owner = new NodeRegistry(mailbox, () => identity)
  return { owner, mailbox }
}

describe('lease-backed runtime registrations', () => {
  it('publishes busy, idle and closing, then removes the released residency', async () => {
    const { owner } = await registry()
    const generation = await owner.register('seat-a', 'busy')
    await owner.assertOwner('seat-a', generation)
    expect(await owner.status('seat-a')).toBe('busy')
    await owner.update('seat-a', 'idle')
    expect(await owner.status('seat-a')).toBe('idle')
    await owner.update('seat-a', 'closing')
    expect(await owner.status('seat-a')).toBe('unavailable')
    await expect(owner.dispose()).rejects.toThrow('active Session leases')
    await owner.unregister('seat-a')
    expect(await owner.status('seat-a')).toBe('closed')
    await expect(owner.assertOwner('seat-a', generation)).rejects.toThrow('generation changed')
    await owner.dispose()
  })

  it('fences an old generation without deleting its successor on teardown', async () => {
    const { owner, mailbox } = await registry()
    const first = await owner.register('seat-a', 'idle')
    const successor = new NodeRegistry(mailbox, () => ({ pid: process.pid, startIdentity: '100', bootIdentity: 'boot-a' }))
    const next = await successor.register('seat-a', 'busy')
    await expect(owner.assertOwner('seat-a', first)).rejects.toThrow('generation changed')
    await owner.unregister('seat-a')
    await successor.assertOwner('seat-a', next)
    expect(await successor.status('seat-a')).toBe('busy')
    await owner.dispose()
    await successor.unregister('seat-a')
    await successor.dispose()
  })
})

describe('persisted recipient policy', () => {
  it.each(['all', 'handoff-only', 'none'] as const)('%s admits handoff and reply independently of notice', async (receiveMode) => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-policy-'))
    homes.push(home)
    const f = await serviceFixture(home)
    try {
      const scheduler = await f.resume()
      const original = await f.service.send({ target: { sessionId: f.session.id }, content: 'original', messageClass: 'notice', operationId: 'original' as OperationId })
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step: 1, signal: new AbortController().signal })
      const settings: MessageSettings = { receiveMode, wakeOnHandoff: false }
      expect(await f.service.configure({ sessionId: f.session.id, settings })).toEqual(settings)
      for (const messageClass of ['handoff', 'reply', 'notice'] as const) {
        const sent = await f.service.send({ target: { sessionId: f.session.id },
          content: messageClass, operationId: messageClass as OperationId,
          ...(messageClass === 'reply' ? { messageClass, replyTo: original.messageId } : { messageClass }) })
        const admitted = receiveMode === 'all' || (receiveMode === 'handoff-only' && messageClass !== 'notice')
        expect(sent.messageState).toBe(admitted ? 'queued' : 'rejected')
      }
      const persisted = await f.ctx.sessionPersistence.open(f.session.id, 'read')
      expect((await persisted.read()).events.some(event => event.type === 'message/settings')).toBe(true)
      await persisted.close()
    } finally { await f.dispose() }
  })

  it('cold-reads policy and rechecks it before admitting an offline send', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-cold-'))
    homes.push(home)
    const f = await serviceFixture(home)
    try {
      const cold = Session.create(SessionId('seat-cold'))
      const lease = await f.ctx.sessionPersistence.create(cold.header)
      const setting = cold.append('message/settings', { receiveMode: 'none', wakeOnHandoff: false })
      await lease.append([setting])
      await lease.close()
      expect(await f.service.send({ target: { sessionId: cold.id }, content: 'denied', messageClass: 'handoff', operationId: 'cold-denied' as OperationId }))
        .toMatchObject({ reason: 'receive-disabled', messageState: 'rejected' })
      const pending = await f.service.send({ target: { sessionId: f.session.id }, content: 'pending', messageClass: 'handoff', operationId: 'pending' as OperationId })
      f.session.append('message/settings', { receiveMode: 'none', wakeOnHandoff: true })
      const scheduler = await f.resume()
      expect(scheduler.queue).toEqual([])
      expect(await f.service.status(pending.messageId)).toMatchObject({ state: 'rejected', phase: 'settled' })
    } finally { await f.dispose() }
  })

  it('deduplicates explicit lists, previews without mailbox writes or wakeups, and keeps each outcome', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delivery-batch-'))
    homes.push(home)
    const f = await serviceFixture(home)
    try {
      const scheduler = await f.resume()
      const cold = Session.create(SessionId('seat-cold'))
      await (await f.ctx.sessionPersistence.create(cold.header)).close()
      const writes = vi.spyOn(FileMailbox.prototype, 'append')
      const wakeups = vi.spyOn(scheduler.agent, 'enqueue')
      const request = { content: 'batch', messageClass: 'handoff' as const, dryRun: true, recipients: [
        { target: { sessionId: f.session.id }, operationId: 'live' as OperationId },
        { target: { sessionId: f.session.id }, operationId: 'duplicate' as OperationId },
        { target: { sessionId: cold.id }, operationId: 'cold' as OperationId },
        { target: { sessionId: SessionId('missing') }, operationId: 'missing' as OperationId },
      ] }
      expect(await f.service.sendBatch(request)).toMatchObject({ kind: 'resolved', recipients: [{ kind: 'resolved' }, { kind: 'resolved' }, { kind: 'rejected' }] })
      expect(writes).toHaveBeenCalledTimes(0)
      expect(wakeups).toHaveBeenCalledTimes(0)
      const sent = await f.service.sendBatch({ ...request, dryRun: false })
      expect(sent).toMatchObject({ kind: 'sent', results: [
        { deliveryOutcome: 'accepted' }, { reason: 'target-closed-pending' }, { reason: 'target-not-found' },
      ] })
      expect(writes).toHaveBeenCalledTimes(2)
      writes.mockRestore()
      wakeups.mockRestore()
    } finally { await f.dispose(); vi.restoreAllMocks() }
  })
})

describe('Windows inherited ACL admission', () => {
  const owner = 'S-1-5-21-100'
  it('permits only the current user, SYSTEM and Administrators read-write grants', () => {
    expect(() => { validateAcl(owner, [owner, 'S-1-5-18', 'S-1-5-32-544'].map(sid =>
      ({ sid, allow: true, rights: 0x1f01ff }))) }).not.toThrow()
  })
  it.each(['S-1-1-0', 'S-1-5-32-545', 'S-1-5-21-200'])('refuses foreign read-write principal %s', (sid) => {
    expect(() => { validateAcl(owner, [{ sid, allow: true, rights: 1 }]) }).toThrow('another principal')
  })
  it('permits deny entries and refuses unavailable ACL evidence', () => {
    expect(() => { validateAcl(owner, [{ sid: 'S-1-1-0', allow: false, rights: 1 }]) }).not.toThrow()
    expect(() => { validateAcl(owner, []) }).toThrow('unavailable')
    expect(() => { validateAcl('unknown', [{ sid: owner, allow: true, rights: 1 }]) }).toThrow('unavailable')
  })
})
