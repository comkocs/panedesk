/** Loader restarts reconcile persisted actions before enabling seat dispatch. */
import { expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Schedule, { ScheduleId, type ScheduleRecord } from '@panedesk/dsh-schedule'
import Storage from '@panedesk/dsh-storage'
import * as JsonStorage from '@panedesk/dsh-storage-json'
import * as Domain from '@panedesk/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composition } from './composition-fixture.ts'
import { projectId, seat } from './fixtures.ts'
import type { ProductionSource } from '../src/production-sources.ts'

const resolver = { apply(ctx: Context) {
  const controller: Pick<Context['sessionController'], 'resolveAgent'> = {
    resolveAgent: async () => { throw new Error('Action must not resolve a session') },
  }
  ctx.provide('sessionController', controller as never)
} }
const initial: ScheduleRecord = { kind: 'every', id: ScheduleId('schedule-a'), title: 'Open seat',
  prompt: 'Open seat', everySeconds: 90, scheduledAt: '2040-01-01T00:01:30.000Z' }
const source = (record: ScheduleRecord): ProductionSource => ({ sourceId: 'schedule-source' as never,
  seat, projectId, trigger: { kind: 'schedule', record } })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seat-schedule-reconcile-'))
  const messages: string[] = []
  const logging = { apply(ctx: Context) {
    ctx.logger.exporter({ levels: { default: 3 }, export(message) { messages.push(String(message.args[0])) } })
  } }
  let host: Awaited<ReturnType<typeof composition>> | undefined
  const boot = async (sources: ProductionSource[]) => {
    await host?.close()
    host = undefined
    const next = await composition(false, { sources, builtins: { schedule: Schedule, storage: Storage,
      json: JsonStorage, domain: Domain, resolver, logging }, entries: [{ name: 'cordis:logging' },
      { name: 'cordis:storage' }, { name: 'cordis:json', config: { root } },
      { name: 'cordis:domain', config: { backend: 'json' } }, { name: 'cordis:resolver' },
      { name: 'cordis:schedule', config: {} }] })
    host = next
    return next.ctx
  }
  return { boot, messages, async close() {
    await host?.close(); host = undefined
    await rm(root, { recursive: true, force: true })
  } }
}

it('replaces a changed selector on restart and dispatches only the new occurrence', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2040-01-01T00:00:00.000Z'))
  const f = await fixture()
  try {
    const first = await f.boot([source(initial)])
    await expect.poll(async () => (await first.schedule.listActions())[0]?.available).toBe(true)
    clock.mockReturnValue(Date.parse(initial.scheduledAt))
    await first.schedule.deleteAction(ScheduleId('absent'))
    await expect.poll(async () => (await first.schedule.listActions())[0]?.lastReceipt?.status).toBe('accepted')
    const record: ScheduleRecord = { kind: 'daily', id: initial.id, title: initial.title, prompt: initial.prompt,
      time: '08:00:00.000', timeZone: 'Asia/Tokyo', scheduledAt: '2040-01-01T23:00:00.000Z' }
    const next = await f.boot([source(record)])
    await expect.poll(async () => (await next.schedule.listActions())[0]?.available).toBe(true)
    expect((await next.schedule.listActions())[0]?.record).toEqual(record)
    expect(f.messages).toContain('Seat schedule source reconciled')
    clock.mockReturnValue(Date.parse(initial.scheduledAt))
    await next.schedule.deleteAction(ScheduleId('absent'))
    expect((await next.seatEngine.pending({ limit: 10 })).items).toHaveLength(0)
    clock.mockReturnValue(Date.parse(record.scheduledAt))
    await next.schedule.deleteAction(ScheduleId('absent'))
    await expect.poll(async () => (await next.schedule.listActions())[0]?.lastReceipt?.scheduledAt).toBe(record.scheduledAt)
    expect((await next.seatEngine.pending({ limit: 10 })).items.map(item => item.triggerKind)).toEqual(['schedule'])
    expect((await next.schedule.listActions())[0]?.record.scheduledAt).toBe('2040-01-02T23:00:00.000Z')
  } finally { await f.close(); clock.mockRestore() }
}, 20000)

it('preserves unchanged normalized records and advanced next occurrences on restart', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2040-01-01T00:00:00.000Z'))
  const f = await fixture()
  try {
    const first = await f.boot([source(initial)])
    await expect.poll(async () => (await first.schedule.listActions())[0]?.available).toBe(true)
    clock.mockReturnValue(Date.parse(initial.scheduledAt))
    await first.schedule.deleteAction(ScheduleId('absent'))
    await expect.poll(async () => (await first.schedule.listActions())[0]?.lastReceipt?.status).toBe('accepted')
    const before = await first.schedule.listActions()
    const reordered: ScheduleRecord = { scheduledAt: initial.scheduledAt, everySeconds: 90,
      prompt: initial.prompt, title: initial.title, id: initial.id, kind: 'every' }
    const create = vi.spyOn(Schedule.prototype, 'scheduleAction')
    const remove = vi.spyOn(Schedule.prototype, 'deleteAction')
    try {
      const next = await f.boot([source(reordered)])
      await expect.poll(async () => (await next.schedule.listActions())[0]?.available).toBe(true)
      expect(await next.schedule.listActions()).toEqual(before)
      expect(create).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(f.messages).not.toContain('Seat schedule source reconciled')
    } finally { create.mockRestore(); remove.mockRestore() }
  } finally { await f.close(); clock.mockRestore() }
}, 20000)

it('removes deleted sources including an empty configuration without touching other actions', async () => {
  const f = await fixture()
  try {
    const first = await f.boot([source(initial)])
    await expect.poll(async () => (await first.schedule.listActions())[0]?.available).toBe(true)
    const foreign = await first.schedule.scheduleAction({ actionId: 'other.open',
      record: { ...initial, id: ScheduleId('foreign-a') }, payload: { sourceId: 'deleted-source' } })
    const next = await f.boot([])
    await expect.poll(async () => (await next.schedule.listActions()).length).toBe(1)
    expect(await next.schedule.listActions()).toEqual([{ ...foreign, available: false }])
    expect(f.messages).toContain('Seat schedule source removed')
  } finally { await f.close() }
}, 20000)

it('warns on reconciliation failure without blocking host startup or disposal', async () => {
  const f = await fixture()
  try {
    const first = await f.boot([source(initial)])
    await expect.poll(async () => (await first.schedule.listActions())[0]?.available).toBe(true)
    const remove = vi.spyOn(Schedule.prototype, 'deleteAction').mockRejectedValueOnce(new Error('Storage unavailable'))
    try {
      const next = await f.boot([])
      await expect.poll(() => f.messages.includes('Seat schedule registration failed')).toBe(true)
      await expect(next.seatEngine.ready()).resolves.toBeUndefined()
      expect(await next.schedule.listActions()).toHaveLength(1)
      await f.close()
    } finally { remove.mockRestore() }
  } finally { await f.close() }
}, 20000)
