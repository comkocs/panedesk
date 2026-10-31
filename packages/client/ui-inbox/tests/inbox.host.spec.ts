/** The inbox bridge retains exact receiving-session filters and owner authority. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { MessageQuery, MessageQuarantineQuery, MessageStatus } from '@panedesk/dsh-message-delivery'
import Inbox from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup(enabled = true) {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  const inbox = new Inbox(ctx, { enabled, pageSize: 1, pollIntervalMs: 1 })
  return { ctx, inbox }
}
function message(id: string, createdAt: number): MessageStatus {
  return { messageId: id as MessageStatus['messageId'], state: 'queued', phase: 'pending', revision: 0, stateVersion: 0, transitions: [],
    metadata: { senderSessionId: null, targetSessionId: 'receiver' as never, priority: 'steer', createdAt } }
}
it('sorts received rows by creation time and identity using only exact existing queries', async () => {
  const { ctx, inbox } = setup(), calls: MessageQuery[] = [], isolated: MessageQuarantineQuery[] = []
  ctx.provide('messageDelivery', {
    list: async (query: MessageQuery) => { calls.push(query); return query.cursor
      ? { items: [message('a', 1), message('b', 1)], complete: true }
      : { items: [message('z', 2)], complete: false, nextCursor: 'next' } },
    quarantined: async (query: MessageQuarantineQuery) => { isolated.push(query); return { items: [], complete: true } },
  } as never)
  const stream = inbox.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]()
  const next = await stream.next()
  expect(next.value).toMatchObject({ items: [{ status: { messageId: 'a' } }, { status: { messageId: 'b' } }, { status: { messageId: 'z' } }] })
  expect(calls).toEqual([{ targetSessionId: 'receiver', includeMetadata: true, pagination: true, limit: 1 },
    { targetSessionId: 'receiver', includeMetadata: true, pagination: true, limit: 1, cursor: 'next' }])
  expect(isolated).toEqual([{ targetSessionId: 'receiver', limit: 1 }])
  await stream.return?.()
})
it('refuses non-owner reads, cancelled invocations and missing legacy capabilities', async () => {
  const { ctx, inbox } = setup()
  Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'guest' } }, signal: new AbortController().signal } })
  await expect(inbox.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('Authenticated owner')
  const cancelled = setup(), controller = new AbortController()
  controller.abort()
  Object.defineProperty(cancelled.ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: controller.signal } })
  await expect(cancelled.inbox.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('observation unavailable')
  const other = setup()
  await expect(other.inbox.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('queries unavailable')
  const disabled = setup(false)
  const stream = disabled.inbox.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ enabled: false, items: [], quarantined: [], complete: true })
  await stream.return?.()
})
it('rejects an empty receiving-session id before querying delivery', async () => {
  const { inbox } = setup()
  const stream = inbox.watch('' as never, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(stream.next()).rejects.toThrow('Receiving Session required')
})
it('loads the read-only feature through a real profile and withdraws it with the Loader entry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'inbox-profile-')); cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(home).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, inbox: Inbox })
  const path = join(home, 'cordis.yml')
  await writeFile(path, JSON.stringify([{ name: 'cordis:inbox', config: { enabled: false, pageSize: 1, pollIntervalMs: 1 } }]))
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  expect((await ctx.get('inbox')!.watch('receiver' as never, new AbortController().signal)[Symbol.asyncIterator]().next()).value).toMatchObject({ enabled: false, items: [] })
  await ctx.loader.resolve(entry).fiber?.dispose()
  expect(ctx.get('inbox')).toBeUndefined()
})
