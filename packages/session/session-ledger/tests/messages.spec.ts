import { afterEach, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import JournalMessageLedger from '../src/messages.ts'
import JournalSessionLedger from '../src/index.ts'
import { messageEventId } from '../src/journal.ts'
import type { MessageLedgerEvent } from '../src/types.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

it('shares the persisted node identity with the full ledger without registering session accounting', async () => {
  const home = await mkdtemp(join(import.meta.dirname, '.message-service-'))
  homes.push(home)
  const ctx = new Context()
  const full = new Context()
  contexts.push(ctx, full)
  const fiber = await ctx.plugin(JournalMessageLedger, { dshHome: home })
  const messages = ctx.get('messageLedger')!
  expect(ctx.get('sessionLedger')).toBeUndefined()
  const id = await messages.nodeId!()
  expect(await readdir(join(home, 'ledger', 'v1'))).toEqual(expect.arrayContaining(['node-id', 'writer.lock']))
  expect(await readdir(join(home, 'ledger', 'v1'))).not.toContain(id)
  const ledger = new JournalSessionLedger(full, { dshHome: home })
  expect(await ledger.nodeId()).toBe(id)
  const data: MessageLedgerEvent['data'] = {
    messageId: 'message-a' as MessageLedgerEvent['data']['messageId'],
    senderSessionId: null, targetSessionId: null, priority: 'queue', messageClass: 'notice',
    state: 'withdrawn', revision: 0, stateVersion: 1,
    operationId: 'operation-a' as MessageLedgerEvent['data']['operationId'],
    transition: 'withdrawn', observedAt: 100,
  }
  const event: MessageLedgerEvent = { schemaVersion: 1, kind: 'message/state', nodeId: id,
    observedAt: data.observedAt, data, eventId: messageEventId({ nodeId: id, data }) }
  await messages.append(event)
  expect(await messages.read({})).toEqual({ events: [event], complete: true })
  expect(await (await ledger.messages()).read({})).toEqual({ events: [event], complete: true })
  expect((await ledger.querySessions({})).unassignedMessages[0]?.state).toBe('withdrawn')
  expect((await ledger.snapshot()).rows).toEqual([])
  await fiber.dispose()
  expect(ctx.get('messageLedger')).toBeUndefined()
})
