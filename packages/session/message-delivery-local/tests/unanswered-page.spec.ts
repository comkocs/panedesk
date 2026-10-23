/** Unanswered scans continue after stable message identities, not mutable offsets. */
import { describe, expect, it } from 'vitest'
import type { MessageCursor, OperationId } from '@panedesk/dsh-message-delivery'
import { wakeupFixture } from './fixtures/wakeup.ts'

describe('unanswered message pages', () => {
  it('pages unanswered handoffs without duplicates when a previous page becomes terminal', async () => {
    const f = await wakeupFixture(false)
    try {
      await f.service.configure({ sessionId: f.session.id, settings: { receiveMode: 'all', wakeOnHandoff: false } })
      const sent = []
      for (const operationId of ['first', 'second', 'third']) {
        sent.push(await f.service.send({ target: { sessionId: f.session.id }, content: operationId,
          messageClass: 'handoff', operationId: operationId as OperationId }))
      }
      await f.service.send({ target: { sessionId: f.session.id }, content: 'notice',
        messageClass: 'notice', operationId: 'notice' as OperationId })
      await f.drain()
      const query = { targetSessionId: f.session.id, unansweredOlderThanMinutes: 0, limit: 1, pagination: true }
      const first = await f.service.list(query)
      expect(first.items).toHaveLength(1)
      expect(first.complete).toBe(false)
      expect(first.nextCursor).toBeDefined()
      await f.service.withdraw({ messageId: first.items[0]!.messageId,
        operationId: 'withdraw' as OperationId, expectedRevision: first.items[0]!.revision })
      const ids = first.items.map(item => item.messageId)
      let cursor = first.nextCursor
      while (cursor !== undefined) {
        const page = await f.service.list({ ...query, cursor })
        ids.push(...page.items.map(item => item.messageId))
        cursor = page.nextCursor
        expect(page.complete).toBe(cursor === undefined)
      }
      expect(ids).toEqual(sent.map(item => item.messageId).sort())
      expect(new Set(ids).size).toBe(3)
      expect((await f.service.list({ ...query, limit: 10 })).items).toHaveLength(2)
      expect((await f.service.list({ ...query, includeTerminal: true, limit: 10 })).items).toHaveLength(3)
      expect(f.wakes).toBe(0)
    } finally { await f.dispose() }
  })

  it('preserves legacy slice and completeness semantics without pagination', async () => {
    const f = await wakeupFixture(false)
    try {
      const query = { targetSessionId: f.session.id }
      expect(await f.service.list({ ...query, limit: 0 })).toEqual({ items: [], complete: true })
      expect(await f.service.list({ ...query, limit: -1 })).toEqual({ items: [], complete: false })
      for (const operationId of ['first', 'second', 'third']) {
        await f.service.send({ target: { sessionId: f.session.id }, content: operationId,
          messageClass: 'notice', operationId: operationId as OperationId })
      }
      await f.drain()
      const all = await f.service.list(query)
      expect(all.items).toHaveLength(3)
      expect(all).toEqual({ items: all.items, complete: true })
      for (const pagination of [undefined, false]) {
        const legacy = { ...query, ...(pagination === undefined ? {} : { pagination }) }
        expect(await f.service.list({ ...legacy, limit: 0 })).toEqual({ items: [], complete: false })
        expect(await f.service.list({ ...legacy, limit: -1 })).toEqual({ items: all.items.slice(0, 2), complete: false })
        expect(await f.service.list({ ...legacy, limit: 1.5 })).toEqual({ items: all.items.slice(0, 1), complete: false })
        expect(await f.service.list({ ...legacy, limit: 1, cursor: 'missing' as MessageCursor }))
          .toEqual({ items: all.items.slice(0, 1), complete: false })
      }
    } finally { await f.dispose() }
  })

  it('rejects unavailable cursors and invalid limits only with strict pagination', async () => {
    const f = await wakeupFixture(false)
    try {
      for (const cursor of ['missing', 'message-list:missing']) {
        await expect(f.service.list({ pagination: true, cursor: cursor as MessageCursor })).rejects.toThrow('cursor is unavailable')
      }
      for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.service.list({ pagination: true, limit })).rejects.toThrow('positive integer')
      }
      expect(await f.service.list({ pagination: true })).toEqual({ items: [], complete: true })
      expect(await f.service.list({})).toEqual({ items: [], complete: true })
    } finally { await f.dispose() }
  })
})
