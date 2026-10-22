import { mkdtemp, readFile, chmod, symlink, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileMailbox } from '../src/mailbox.ts'
import { publish, readValue, privateDirectory, object } from '../src/files.ts'
import { wakeupFixture } from './fixtures/wakeup.ts'
import { NodeRegistry } from '../src/registry.ts'
import type { OperationId, MessageCursor } from '@panedesk/dsh-message-delivery'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function storage() {
  const home = await mkdtemp(join(tmpdir(), 'mailbox-'))
  homes.push(home)
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 65536, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  return { home, mailbox }
}

describe('wake and receipt lifecycle', () => {
  it('keeps notices and wake-disabled handoffs passive until a natural turn', async () => {
    const f = await wakeupFixture(false)
    try {
      const notice = await f.service.send({ target: { sessionId: f.session.id }, content: 'notice', messageClass: 'notice', operationId: 'notice' as OperationId })
      await f.drain()
      expect(f.wakes).toBe(0)
      expect(f.scheduler.options.get(notice.messageId)).toMatchObject({ passive: true, wakeup: false, priority: 'queue' })
      await f.service.configure({ sessionId: f.session.id, settings: { receiveMode: 'all', wakeOnHandoff: false } })
      const handoff = await f.service.send({ target: { sessionId: f.session.id }, content: 'handoff', messageClass: 'handoff', operationId: 'handoff' as OperationId })
      await f.drain()
      expect(f.wakes).toBe(0)
      expect(f.scheduler.options.get(handoff.messageId)).toMatchObject({ passive: true, wakeup: false })
      await f.service.configure({ sessionId: f.session.id, settings: { receiveMode: 'all', wakeOnHandoff: true } })
      const active = await f.service.send({ target: { sessionId: f.session.id }, content: 'active', messageClass: 'handoff', operationId: 'active' as OperationId })
      await f.started(active.messageId)
      expect(f.starts.has(notice.messageId)).toBe(true)
      expect(f.starts.has(handoff.messageId)).toBe(true)
      expect(f.wakes).toBe(1)
    } finally { await f.dispose() }
  })

  it('replays receipts strictly after cursor without queue input or wakeup', async () => {
    const f = await wakeupFixture(false)
    try {
      const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'notice', messageClass: 'notice', operationId: 'notice' as OperationId })
      await f.drain()
      const first = f.service.subscribe({ sessionId: f.session.id })[Symbol.asyncIterator]()
      const receipt = await first.next()
      await first.return?.()
      if (receipt.done) throw new Error('Receipt unavailable')
      expect(receipt.value.data.messageId).toBe(sent.messageId)
      await f.service.withdraw({ messageId: sent.messageId, operationId: 'withdraw' as OperationId, expectedRevision: 0 })
      const resumed = f.service.subscribe({ sessionId: f.session.id, cursor: receipt.value.cursor })[Symbol.asyncIterator]()
      const next = await resumed.next()
      await resumed.return?.()
      if (next.done) throw new Error('Receipt unavailable')
      expect(next.value.data.transition).toBe('withdrawn')
      expect(next.value.cursor).not.toBe(receipt.value.cursor)
      expect(f.scheduler.queue).toEqual([])
      expect(f.wakes).toBe(0)
      await expect(f.service.subscribe({ sessionId: f.session.id, cursor: 'missing' as MessageCursor })[Symbol.asyncIterator]().next()).rejects.toThrow('cursor is unavailable')
    } finally { await f.dispose() }
  })

  it('registers a headless residency, fences closing, and unregisters after lease release', async () => {
    const f = await wakeupFixture(false)
    const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    const registry = new NodeRegistry(mailbox)
    try {
      expect(await registry.status(f.session.id)).toBe('idle')
      await f.ctx.agents.ending(f.scheduler.agent)
      expect(await registry.status(f.session.id)).toBe('unavailable')
      const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'closing', messageClass: 'handoff', operationId: 'closing' as OperationId })
      expect(sent).toMatchObject({ reason: 'unavailable' })
      await f.scheduler.close()
      // Provider disposal awaits its tracked unregister write; no timed barrier is used.
      await f.ctx.fiber.dispose()
      expect(await registry.status(f.session.id)).toBe('closed')
    } finally { await f.dispose() }
  })
})

describe('file mailbox publication', () => {
  it('serializes concurrent sends and controls and replays an operation without allocating again', async () => {
    const { mailbox } = await storage()
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      mailbox.append('seat-a', `operation-${index}`, `digest-${index}`, { kind: index % 2 ? 'withdraw' : 'send' })))
    expect(records.map(record => record.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    const repeated = await mailbox.append('seat-a', 'operation-0', 'digest-0', { ignored: true })
    expect(repeated).toEqual(records[0])
    await expect(mailbox.append('seat-a', 'operation-0', 'different', {})).rejects.toThrow('Conflicting mailbox operation')
    expect((await mailbox.snapshot('seat-a')).records).toHaveLength(20)
  })

  it('recovers a stale watermark and reports sequence holes without awaiting absent records', async () => {
    const { mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    await publish(join(root, 'records', '0000000000000003.json'),
      { sequence: 3, operationId: 'operation-a', digest: 'digest-a', value: {} }, 65536)
    await publish(join(root, 'watermark.json'), { sequence: 1 }, 65536)
    await writeFile(join(root, 'records', '.pending-incomplete'), '{', { mode: 0o600 })
    expect(await mailbox.snapshot('seat-a')).toMatchObject({ high: 3, skipped: [[1, 2]] })
    expect((await mailbox.append('seat-a', 'operation-b', 'digest-b', {})).sequence).toBe(4)
  })

  it('rejects corrupted version, length and digest envelopes', async () => {
    const { mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    const path = join(root, 'receipts', 'sample.json')
    for (const change of [{ version: 2 }, { length: 0 }, { digest: 'bad' }]) {
      await publish(path, { text: 'héllo' }, 65536)
      const envelope: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!object(envelope)) throw new Error('Expected an envelope object')
      await writeFile(path, JSON.stringify({ ...envelope, ...change }), { mode: 0o600 })
      await expect(readValue(path, 65536)).rejects.toThrow('checksum or version')
    }
    await expect(publish(path, { text: 'é'.repeat(100) }, 100)).rejects.toThrow('byte limit')
  })

  it.skipIf(process.platform === 'win32')('creates private files and refuses linked directories and files', async () => {
    const { home, mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    const path = join(root, 'receipts', 'sample.json')
    await publish(path, {}, 65536)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await symlink(root, join(home, 'linked'))
    await expect(privateDirectory(home, join(home, 'linked'))).rejects.toThrow()
    await symlink(path, join(root, 'receipts', 'linked.json'))
    await expect(readValue(join(root, 'receipts', 'linked.json'), 65536)).rejects.toThrow()
    await chmod(path, 0o644)
    await expect(readValue(path, 65536)).rejects.toThrow('permissions')
  })
})
