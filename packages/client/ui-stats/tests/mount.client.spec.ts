/** Client registrations and resource cancellation follow the owning plugin lifetime. */
import { Context, Service } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { TypertRemoteContribution, RemoteResult } from '@panedesk/dsh-typert-protocol'
import { summarizeStats } from '@panedesk/dsh-ledger-query/src/stats.ts'
import { apply, inject, type StatsData } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

type Provider = { protocol: string; open(address: string, options: { signal: AbortSignal }): AsyncIterable<RemoteResult<StatsData>> }
async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unmount = vi.fn(async () => {})
  const result = { view: summarizeStats({ asOf: 1, complete: true, rows: [], watermarks: {} }, { range: 'all', bucket: 'hour', groupBy: 'seat' }, 1), refreshIntervalMs: 1000 }
  const read = vi.fn(async (): Promise<RemoteResult<StatsData>> => ({ ok: true, value: result }))
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(_contribution: TypertRemoteContribution) { return unmount }
  }
  new Remote()
  ctx.provide('remote.stats', { read } as never)
  const dictionaries = new Map<string, unknown>(), resources = new Map<string, Provider>(), entries = new Set<string>()
  ctx.provide('locale', { register: (name: string, value: unknown) => {
    dictionaries.set(name, value)
    return () => { dictionaries.delete(name) }
  }, bind: () => (key: keyof typeof en) => en[key] } as never)
  ctx.provide('resources', { register: (provider: Provider) => {
    resources.set(provider.protocol, provider)
    return () => { resources.delete(provider.protocol) }
  } } as never)
  ctx.provide('layout', { selectPanel: vi.fn() } as never)
  class Slots extends Service {
    constructor() { super(ctx, 'slots') }
    inject(_name: string, register: () => () => void) { return this.ctx.effect(register) }
    register({ name }: { name: string }) {
      entries.add(name)
      return () => { entries.delete(name) }
    }
  }
  new Slots()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const provider = resources.get('stats')!
  return { fiber, provider, dictionaries, resources, entries, read, unmount, result }
}
it('withdraws all three additive entries, resources, locale and generated Remote on unload and remount', async () => {
  const h = await setup()
  expect(h.dictionaries.get('stats')).toEqual({ en, zh })
  expect([...h.entries]).toEqual(['main', 'settings.section', 'conversation.session.header.utilities'])
  expect([...h.resources.keys()]).toEqual(['stats'])
  await h.fiber.dispose()
  expect(h.entries.size).toBe(0)
  expect(h.resources.size).toBe(0)
  expect(h.dictionaries.size).toBe(0)
  expect(h.unmount).toHaveBeenCalledOnce()
  const remounted = await setup()
  expect(remounted.entries.size).toBe(3)
})
it('reads a paused snapshot once and validates selection through the resource parser', async () => {
  const h = await setup(), values = []
  for await (const value of h.provider.open('dsh-resource://stats/view?paused=true&range=72h&groupBy=taskId&bucket=day&seat=seat-a&model=model-a', { signal: new AbortController().signal })) values.push(value)
  expect(values).toEqual([{ ok: true, value: h.result }])
  expect(h.read).toHaveBeenCalledExactlyOnceWith({ range: '72h', bucket: 'day', groupBy: 'taskId', seat: 'seat-a', model: 'model-a' })
})
it('does not publish an in-flight read after cancellation', async () => {
  const h = await setup(), controller = new AbortController()
  const pending = Promise.withResolvers<RemoteResult<StatsData>>()
  h.read.mockImplementationOnce(() => pending.promise)
  const iterator = h.provider.open('dsh-resource://stats/view', { signal: controller.signal })[Symbol.asyncIterator]()
  const next = iterator.next()
  controller.abort()
  pending.resolve({ ok: true, value: h.result })
  expect(await next).toEqual({ done: true, value: undefined })
})
it('cancels polling waits and skips reads for an already cancelled resource', async () => {
  const h = await setup(), controller = new AbortController()
  const iterator = h.provider.open('dsh-resource://stats/view', { signal: controller.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const next = iterator.next()
  controller.abort()
  expect((await next).done).toBe(true)
  for await (const _value of h.provider.open('dsh-resource://stats/view', { signal: controller.signal })) throw new Error('Unexpected cancelled publication')
  expect(h.read).toHaveBeenCalledOnce()
})
