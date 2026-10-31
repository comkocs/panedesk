/** Cache resources refresh observed evidence and stop when their last reader releases. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session/types'
import { cacheProvider } from '../src/client/resource.ts'

afterEach(() => { vi.useRealTimers() })

describe('cache resource', () => {
  it('refreshes automatic main and child hits without inventing a countdown', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ status: 'ready' as const, tiers: [], rows: [
      { sessionId: 'main' as SessionId, role: 'main' as const, kind: 'automatic' as const, cacheReadTokens: 128 },
      { sessionId: 'child' as SessionId, role: 'subagent' as const, kind: 'automatic' as const },
    ] }))
    const abort = new AbortController()
    const stream = cacheProvider(read).open('dsh-resource://sessioncache/main', { signal: abort.signal })[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ ok: true, value: { rows: [{ cacheReadTokens: 128 }, { kind: 'automatic' }] } })
    const next = stream.next()
    await vi.advanceTimersByTimeAsync(4000)
    expect((await next).done).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    abort.abort()
    expect((await stream.next()).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports failed reads visibly and never opens an already cancelled resource', async () => {
    const read = vi.fn(async (): Promise<never> => { throw new Error('not readable') })
    const abort = new AbortController()
    const stream = cacheProvider(read).open('dsh-resource://sessioncache/main', { signal: abort.signal })[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual({ ok: true, value: { status: 'error' } })
    abort.abort()
    await stream.next()
    const closed = cacheProvider(read).open('dsh-resource://sessioncache/main', { signal: abort.signal })[Symbol.asyncIterator]()
    expect((await closed.next()).done).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
