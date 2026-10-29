import { mkdtemp, readFile, chmod, symlink, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('re-registers a live window after provider reload and fences the previous generation', async () => {
    const f = await wakeupFixture(false)
    const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    const registry = new NodeRegistry(mailbox)
    try {
      const path = join(mailbox.root, 'owners', `${f.session.id}.json`)
      const previous = await readValue(path, 1048576)
      const entry = [...f.ctx.loader.entries()].find(item => item.options.name === 'cordis:delivery')!
      await entry.fiber!.dispose()
      expect(await registry.status(f.session.id)).toBe('unavailable')
      const replacementId = await f.ctx.loader.create({ name: 'cordis:delivery', config: { dshHome: f.home, nodeId: 'node-a',
        maxRecordBytes: 1048576, maxContentBytes: 4096, maxBatchSize: 100,
        lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100, watch: false } })
      await f.ctx.loader.await()
      const service = f.ctx.get('messageDelivery')!
      expect(await registry.status(f.session.id)).toBe('idle')
      expect(await readValue(path, 1048576)).not.toEqual(previous)
      const sent = await service.send({ target: { sessionId: f.session.id }, content: 'after reload',
        messageClass: 'handoff', operationId: 'reload-send' as OperationId })
      expect(sent.deliveryOutcome).toBe('accepted')
      await f.started(sent.messageId)
      expect(f.scheduler.queue.filter(message => message.id === sent.messageId)).toHaveLength(1)
      await f.scheduler.close()
      await f.ctx.loader.resolve(replacementId).fiber!.dispose()
      expect(await registry.status(f.session.id)).toBe('closed')
    } finally { await f.dispose() }
  })

  it('keeps an ending residency unavailable when reload registration is still in flight', async () => {
    const f = await wakeupFixture(false)
    const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    const registry = new NodeRegistry(mailbox)
    const registered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // Invoke the original method only with its captured registry receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const register = NodeRegistry.prototype.register
    const registering = vi.spyOn(NodeRegistry.prototype, 'register').mockImplementation(async function (this: NodeRegistry, ...args) {
      const generation = await register.apply(this, args)
      registered.resolve(undefined)
      await release.promise
      return generation
    })
    try {
      const entry = [...f.ctx.loader.entries()].find(item => item.options.name === 'cordis:delivery')!
      await entry.fiber!.dispose()
      const loading = f.ctx.loader.create({ name: 'cordis:delivery', config: { dshHome: f.home, nodeId: 'node-a',
        maxRecordBytes: 1048576, maxContentBytes: 4096, maxBatchSize: 100,
        lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100, watch: false } })
      await registered.promise
      const ending = f.ctx.agents.ending(f.scheduler.agent)
      release.resolve(undefined)
      const replacementId = await loading
      await f.ctx.loader.await()
      await ending
      expect(registering).toHaveBeenCalledTimes(1)
      expect(await registry.status(f.session.id)).toBe('unavailable')
      await f.scheduler.close()
      await f.ctx.loader.resolve(replacementId).fiber!.dispose()
      expect(await registry.status(f.session.id)).toBe('closed')
    } finally { release.resolve(undefined); registering.mockRestore(); await f.dispose() }
  })

  it('ignores stale Agent callbacks after the same Session gains a replacement', async () => {
    const f = await wakeupFixture(false)
    const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    const registry = new NodeRegistry(mailbox)
    try {
      const old = f.scheduler.agent
      await f.scheduler.close()
      const replacement = await f.resume()
      await f.ctx.serial('agent/status', { agent: old, status: 'running' })
      await f.ctx.serial('agent/ending', { agent: old })
      await f.ctx.serial('agent/disposed', { agent: old })
      await f.ctx.serial('agent/input-preparing', { agent: old, turn: 1, step: 1, signal: new AbortController().signal })
      expect(await registry.status(f.session.id)).toBe('idle')
      const sent = await f.service.send({ target: { sessionId: f.session.id }, content: 'new residency',
        messageClass: 'handoff', operationId: 'replacement-send' as OperationId })
      expect(sent.deliveryOutcome).toBe('accepted')
      await expect.poll(() => replacement.queue.filter(message => message.id === sent.messageId)).toHaveLength(1)
      expect(old).not.toBe(replacement.agent)
      await replacement.close()
    } finally { await f.dispose() }
  })

  it('does not adopt an already ending Agent during provider reload', async () => {
    const f = await wakeupFixture(false)
    const register = vi.spyOn(NodeRegistry.prototype, 'register')
    try {
      await f.ctx.agents.ending(f.scheduler.agent)
      const entry = [...f.ctx.loader.entries()].find(item => item.options.name === 'cordis:delivery')!
      await entry.fiber!.dispose()
      const id = await f.ctx.loader.create({ name: 'cordis:delivery', config: { dshHome: f.home, nodeId: 'node-a',
        maxRecordBytes: 1048576, maxContentBytes: 4096, maxBatchSize: 100,
        lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100, watch: false } })
      await f.ctx.loader.await()
      expect(register).not.toHaveBeenCalled()
      const result = await f.ctx.get('messageDelivery')!.send({ target: { sessionId: f.session.id }, content: 'must not reopen',
        messageClass: 'handoff', operationId: 'ending-send' as OperationId })
      expect(result).toMatchObject({ deliveryOutcome: 'rejected', reason: 'unavailable' })
      expect(f.scheduler.queue).toHaveLength(0)
      await f.scheduler.close()
      await f.ctx.loader.resolve(id).fiber!.dispose()
    } finally { register.mockRestore(); await f.dispose() }
  })

  it('re-resolves an unavailable rejection with the same operation and delivers exactly once', async () => {
    const f = await wakeupFixture(false)
    const request = { target: { sessionId: f.session.id }, content: 'retry completion',
      messageClass: 'handoff' as const, operationId: 'retry-completion' as OperationId }
    const status = vi.spyOn(NodeRegistry.prototype, 'status').mockResolvedValue('unavailable')
    try {
      expect(await f.service.send(request)).toMatchObject({ deliveryOutcome: 'rejected', reason: 'unavailable', pending: false })
      status.mockRestore()
      const accepted = await f.service.send(request)
      expect(accepted.deliveryOutcome).toBe('accepted')
      await f.started(accepted.messageId)
      expect(await f.service.send(request)).toEqual(accepted)
      expect((await f.service.list({ targetSessionId: f.session.id })).items).toHaveLength(1)
      expect(f.scheduler.queue.filter(message => message.id === accepted.messageId)).toHaveLength(1)
      await expect(f.service.send({ ...request, content: 'different completion' })).rejects.toThrow('operation-conflict')
    } finally { status.mockRestore(); await f.dispose() }
  })

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
      f.ctx.emit('agent/status', { agent: f.scheduler.agent, status: 'idle' })
      await f.drain()
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

describe('registry shutdown', () => {
  it('keeps closing through late status updates and heartbeat writes', async () => {
    const { mailbox } = await storage()
    const registry = new NodeRegistry(mailbox)
    await registry.register('seat-a', 'idle')
    await registry.update('seat-a', 'closing')
    await registry.update('seat-a', 'idle')
    await registry.heartbeat()
    expect(await registry.status('seat-a')).toBe('unavailable')
    await registry.unregister('seat-a')
    await registry.dispose()
    expect(await registry.status('seat-a')).toBe('closed')
  })

  it('retains lifecycle listeners during root shutdown until the lease is released', async () => {
    const f = await wakeupFixture(false)
    const mailbox = new FileMailbox({ home: f.home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
    const registry = new NodeRegistry(mailbox)
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the registry receiver.
    const update = NodeRegistry.prototype.update
    const observed = vi.spyOn(NodeRegistry.prototype, 'update').mockImplementation(async function (this: NodeRegistry, id, status) {
      await update.call(this, id, status)
      if (status === 'closing') closing.resolve(undefined)
    })
    f.ctx.effect(() => async () => { await release.promise; await f.scheduler.close() })
    const disposing = f.ctx.fiber.dispose()
    try {
      await closing.promise
      expect(await registry.status(f.session.id)).toBe('unavailable')
      release.resolve(undefined)
      await disposing
      expect(await registry.status(f.session.id)).toBe('closed')
    } finally {
      release.resolve(undefined)
      await disposing
      observed.mockRestore()
      await f.dispose()
    }
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
    await expect(readValue(path, 65536)).rejects.toThrow('Mailbox file permissions are not private')
  })
})
