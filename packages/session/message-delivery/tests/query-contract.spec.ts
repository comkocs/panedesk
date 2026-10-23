/** Query pagination remains optional for existing callers. */
import { expect, it } from 'vitest'
import type { MessageCursor, MessagePage, MessageQuery } from '../src/types.ts'

it('keeps legacy queries valid and carries an optional exclusive continuation', () => {
  const legacy: MessageQuery = { unansweredOlderThanMinutes: 30 }
  const page: MessagePage = { items: [], complete: false, nextCursor: 'page-a' as MessageCursor }
  const continued: MessageQuery = { ...legacy, cursor: page.nextCursor!, limit: 1 }
  expect(legacy).toEqual({ unansweredOlderThanMinutes: 30 })
  expect(continued).toEqual({ unansweredOlderThanMinutes: 30, cursor: 'page-a', limit: 1 })
  expect({ items: [], complete: true } satisfies MessagePage).not.toHaveProperty('nextCursor')
})
