import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { MessageId } from '@panedesk/dsh-llm'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { serviceFixture } from './fixtures/persistence.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { object, publish, publishedFiles } from '../src/files.ts'

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'delivery-quarantine-'))
  const f = await serviceFixture(home)
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
  const root = await mailbox.target(f.session.id)
  const send = (id: string) => f.service.send({ target: { sessionId: f.session.id }, content: id,
    messageClass: 'handoff', operationId: id as OperationId })
  return { ...f, home, root, mailbox, send,
    async cleanup() { try { await f.dispose() } finally { await rm(home, { recursive: true, force: true }) } } }
}

async function corrupt(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!object(value)) throw new Error('Expected record envelope')
  const bytes = JSON.stringify({ ...value, digest: 'damaged' }) + '\n'
  await writeFile(path, bytes)
  return bytes
}

describe('mailbox record quarantine', () => {
  it('adds optional metadata to the existing list, including messages awaiting their first receipt', async () => {
    const f = await setup()
    try {
      const sent = await f.send('send-a')
      const legacy = await f.service.list({ targetSessionId: f.session.id })
      expect(legacy.items[0]).not.toHaveProperty('metadata')
      const page = await f.service.list({ targetSessionId: f.session.id, includeMetadata: true })
      expect(page).toMatchObject({ items: [{
        messageId: sent.messageId, state: 'queued', transitions: [],
        metadata: { senderSessionId: null, targetSessionId: f.session.id, priority: 'steer' },
      }] })
      expect(page.items[0]?.metadata?.createdAt).toBeTypeOf('number')
    } finally { await f.cleanup() }
  })
  it('moves one damaged record unchanged and delivers the two following messages', async () => {
    const f = await setup()
    try {
      const bad = await f.send('send-a')
      const good = [await f.send('send-b'), await f.send('send-c')]
      const name = (await publishedFiles(join(f.root, 'records')))[0]!
      const bytes = await corrupt(join(f.root, 'records', name))
      const scheduler = await f.resume()
      expect(scheduler.queue.map(message => message.id)).toEqual(good.map(message => message.messageId))
      expect(await readFile(join(f.root, 'quarantine', name), 'utf8')).toBe(bytes)
      expect(await publishedFiles(join(f.root, 'records'))).not.toContain(name)
      expect((await f.ledger.read()).events.filter(event => event.kind === 'message/quarantined')).toMatchObject([
        { kind: 'message/quarantined', data: { messageId: bad.messageId, reason: 'corrupt', originalFileName: name } },
      ])
      await expect(f.service.status(bad.messageId)).rejects.toThrow('message-not-found')
    } finally { await f.cleanup() }
  })

  it('drains twice after quarantine without repeating the failure or diagnostic', async () => {
    const f = await setup()
    try {
      await f.send('send-a')
      const name = (await publishedFiles(join(f.root, 'records')))[0]!
      await corrupt(join(f.root, 'records', name))
      const warn = vi.spyOn(f.ctx.logger, 'warn')
      const scheduler = await f.resume()
      for (let step = 1; step <= 2; step++) await f.ctx.serial('agent/input-preparing', {
        agent: scheduler.agent, turn: 1, step, signal: new AbortController().signal,
      })
      expect((await f.ledger.read()).events.filter(event => event.kind === 'message/quarantined')).toHaveLength(1)
      expect(warn.mock.calls.filter(call => call[0] === 'Mailbox record quarantined')).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('retains an unidentified raw event, omits message results and diagnoses its paths once', async () => {
    const f = await setup()
    try {
      const name = '0000000000000001.json'
      await publish(join(f.root, 'records', name), { sequence: 1, operationId: 'bad-a', digest: 'bad', value: {} }, 1048576)
      const warn = vi.spyOn(f.ctx.logger, 'warn')
      await f.resume()
      const isolated = (await f.ledger.read()).events.filter(event => event.kind === 'message/quarantined')
      expect(isolated).toHaveLength(1)
      expect(isolated[0]?.data).not.toHaveProperty('messageId')
      expect((await f.service.list({})).items).toEqual([])
      await expect(f.service.status('missing' as MessageId)).rejects.toThrow('message-not-found')
      expect(warn.mock.calls.filter(call => call[0] === 'Mailbox record quarantined')).toEqual([
        ['Mailbox record quarantined', { originalFileName: name, quarantinePath: join(f.root, 'quarantine', name) }],
      ])
    } finally { await f.cleanup() }
  })

  it.skipIf(process.platform === 'win32')('keeps permission failures sticky without quarantining the evidence', async () => {
    const f = await setup()
    try {
      await f.send('send-a')
      const scheduler = await f.resume()
      const name = (await publishedFiles(join(f.root, 'records')))[0]!
      const path = join(f.root, 'records', name)
      await chmod(path, 0o644)
      const drain = () => f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: 1, step: 1, signal: new AbortController().signal })
      await expect(drain()).rejects.toThrow('Mailbox file permissions are not private')
      await chmod(path, 0o600)
      await expect(drain()).rejects.toThrow('Owner arbitration failed')
      expect((await f.ledger.read()).events.some(event => event.kind === 'message/quarantined')).toBe(false)
      await expect(f.dispose()).rejects.toThrow('Owner arbitration failed')
    } finally { await f.ctx.fiber.dispose().catch(() => undefined); await rm(f.home, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('retains owner-only quarantine directory and file modes and ownership', async () => {
    const f = await setup()
    try {
      await f.send('send-a')
      const name = (await publishedFiles(join(f.root, 'records')))[0]!
      await corrupt(join(f.root, 'records', name))
      await f.resume()
      const directory = await lstat(join(f.root, 'quarantine'))
      const file = await lstat(join(f.root, 'quarantine', name))
      expect(directory.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
      expect(directory.uid).toBe(process.getuid?.())
      expect(file.uid).toBe(process.getuid?.())
      expect(directory.isSymbolicLink() || file.isSymbolicLink()).toBe(false)
    } finally { await f.cleanup() }
  })
})
