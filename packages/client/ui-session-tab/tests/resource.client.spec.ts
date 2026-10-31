/** Session acquisition failures settle the resource instead of leaving it loading. */
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@panedesk/dsh-api-session-controller/client'
import { sessionTabProvider } from '../src/client/resource.ts'

it.each([
  ['malformed escape', 'dsh-resource://sessiontab/%E0%A4%A', 0, 'gateway/bad-request'],
  ['synchronous retain failure', 'dsh-resource://sessiontab/missing', 1, 'session/not-found'],
] as const)('publishes a failure for %s', async (_name, address, acquisitions, code) => {
  const retain = vi.fn<ISessions['retain']>(() => { throw new Error('Session is unavailable') })
  const sessions = { retain }
  const stream = sessionTabProvider(sessions).open(address, { signal: new AbortController().signal })[Symbol.asyncIterator]()
  await expect(stream.next()).resolves.toMatchObject({ done: false, value: { ok: false, error: { code } } })
  expect(retain).toHaveBeenCalledTimes(acquisitions)
  await expect(stream.next()).resolves.toMatchObject({ done: true })
})
