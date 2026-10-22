import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, mkdir, rename, appendFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '../src/index.ts'
import { appendMessageUnique, messageEventId, recoverMessageSegments } from '../src/journal.ts'
import type { MessageLedgerEvent } from '../src/types.ts'
import { options } from './fixtures.ts'

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(import.meta.dirname, '.messages-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function message(overrides: Partial<MessageLedgerEvent['data']> = {}): MessageLedgerEvent {
  const data: MessageLedgerEvent['data'] = {
    messageId: 'message-a' as MessageLedgerEvent['data']['messageId'],
    senderSessionId: null, targetSessionId: null, priority: 'steer', messageClass: 'handoff',
    state: 'queued', revision: 0, stateVersion: 0, operationId: 'operation-a' as MessageLedgerEvent['data']['operationId'],
    transition: 'accepted', observedAt: 100, ...overrides,
  }
  const nodeId = 'node-a' as MessageLedgerEvent['nodeId']
  return { schemaVersion: 1, eventId: messageEventId({ nodeId, data }), nodeId, observedAt: data.observedAt, kind: 'message/state', data }
}

describe('message journal', () => {
  it('stores human-origin facts without a fabricated session or run and replays one unique slot', async () => {
    const path = await root()
    const input = message()
    const cursors = await Promise.all(Array.from({ length: 4 }, () => appendMessageUnique(path, input, options)))
    expect(new Set(cursors).size).toBe(1)
    expect(await recoverMessageSegments(path, options.maxRecordBytes)).toMatchObject({ events: [input], complete: true, corrupt: [], tails: [] })
    expect((await stat(join(path, 'writer.lock'))).mode & 0o777).toBe(0o600)
    const file = (await readdir(join(path, 'events'), { recursive: true })).find(name => name.endsWith('.jsonl'))!
    expect((await stat(join(path, 'events', file))).mode & 0o777).toBe(0o600)
    expect(input).not.toHaveProperty('runId')
    expect(input).not.toHaveProperty('sessionId')
  })

  it('rejects changed payloads and contradictory transitions at the same state version', async () => {
    const path = await root()
    await appendMessageUnique(path, message(), options)
    await expect(appendMessageUnique(path, message({ priority: 'immediate' }), options)).rejects.toThrow('Conflicting')
    await expect(appendMessageUnique(path, message({ state: 'withdrawn', transition: 'withdrawn' }), options)).rejects.toThrow('Conflicting')
    expect((await recoverMessageSegments(path, options.maxRecordBytes)).events).toHaveLength(1)
  })

  it('rejects body fields and malformed durable identities before writing', async () => {
    const path = await root()
    const input = message()
    await expect(appendMessageUnique(path, { ...input, data: Object.assign({}, input.data, { content: 'private body' }) }, options)).rejects.toThrow('Unexpected')
    await expect(appendMessageUnique(path, { ...input, eventId: 'forged' as typeof input.eventId }, options)).rejects.toThrow('identity')
    await expect(appendMessageUnique(path, message({ stateVersion: -1 }), options)).rejects.toThrow()
    expect((await recoverMessageSegments(path, options.maxRecordBytes)).events).toHaveLength(0)
  })

  it('preserves interrupted tails and continues in new segments across UTC partitions', async () => {
    const path = await root()
    await appendMessageUnique(path, message(), options)
    const file = (await readdir(join(path, 'events'), { recursive: true })).find(name => name.endsWith('.jsonl'))!
    await mkdir(join(path, 'events', '2000-01-01'))
    const old = join(path, 'events', '2000-01-01', 'old.jsonl')
    await rename(join(path, 'events', file), old)
    await appendFile(old, '{"incomplete":')
    const before = await readFile(old)
    await appendMessageUnique(path, message({ stateVersion: 1, state: 'injected', transition: 'injected', observedAt: 200 }), options)
    expect(await readFile(old)).toEqual(before)
    expect(await recoverMessageSegments(path, options.maxRecordBytes)).toMatchObject({ complete: false, corrupt: [], tails: [old] })
    expect((await recoverMessageSegments(path, options.maxRecordBytes)).events).toHaveLength(2)
  })

  it('reports complete-line corruption and refuses subsequent writes', async () => {
    const path = await root()
    await appendMessageUnique(path, message(), options)
    const file = (await readdir(join(path, 'events'), { recursive: true })).find(name => name.endsWith('.jsonl'))!
    await appendFile(join(path, 'events', file), '{}\n')
    expect((await recoverMessageSegments(path, options.maxRecordBytes)).corrupt).toHaveLength(1)
    await expect(appendMessageUnique(path, message({ stateVersion: 1 }), options)).rejects.toThrow('corruption')
  })

  it('exposes the separate namespace without adding message rows to call snapshots', async () => {
    const home = await root()
    const ctx = new Context()
    const ledger = new JournalSessionLedger(ctx, { dshHome: home })
    const store = await ledger.messages()
    try {
      await store.append(message())
      expect((await store.read({})).events).toEqual([message()])
      expect((await ledger.snapshot()).rows).toEqual([])
      expect(await readdir(join(home, 'ledger'))).toEqual(expect.arrayContaining(['v1', 'messages']))
    } finally { await ctx.stop() }
  })
})
