/** Owner checks run before ledger reads, including the real Loader composition. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Stats from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = { range: 'today', bucket: 'hour', groupBy: 'seat' } as const
function setup(enabled = true) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const query = new LedgerQuery(ctx)
  const reads = vi.spyOn(query, 'stats')
  const controller = new AbortController()
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: controller.signal } })
  const stats = new Stats(ctx, { enabled, refreshIntervalMs: 1000 })
  return { ctx, query, reads, stats, controller }
}
it('reads a coverage-aware snapshot without requiring or starting a ledger writer', async () => {
  const h = setup()
  const value = await h.stats.read(request)
  expect(value).toMatchObject({ refreshIntervalMs: 1000, view: { complete: false, summary: { calls: 0 }, runningLanes: { count: null } } })
  expect(h.reads).toHaveBeenCalledWith(request)
  expect(h.ctx.get('sessionLedger')).toBeUndefined()
})
it.each(['guest', 'anonymous', 'session'])('refuses %s before accessing any ledger data', async (kind) => {
  const h = setup()
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind } }, signal: h.controller.signal } })
  await expect(h.stats.read(request)).rejects.toMatchObject({ code: 'stats/unauthorized' })
  expect(h.reads).not.toHaveBeenCalled()
})
it('rejects missing caller, disabled configuration and cancelled invocations without reading', async () => {
  const h = setup()
  Object.defineProperty(h.ctx, 'invocation', { value: undefined })
  await expect(h.stats.read(request)).rejects.toMatchObject({ code: 'stats/unauthorized' })
  expect(h.reads).not.toHaveBeenCalled()
  const disabled = setup(false)
  await expect(disabled.stats.read(request)).rejects.toMatchObject({ code: 'stats/disabled' })
  expect(disabled.reads).not.toHaveBeenCalled()
  const aborted = setup()
  aborted.controller.abort()
  await expect(aborted.stats.read(request)).rejects.toMatchObject({ code: 'stats/unavailable' })
  expect(aborted.reads).not.toHaveBeenCalled()
})
it('loads the query and statistics plugin through a file-backed Loader and withdraws the namespace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ledger-stats-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(home).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, ledgerQuery: LedgerQuery, stats: Stats })
  const profile = join(home, 'cordis.yml')
  await writeFile(profile, JSON.stringify([
    { name: 'cordis:ledgerQuery' },
    { name: 'cordis:stats', config: { enabled: true, refreshIntervalMs: 1000 } },
  ]))
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  expect(await ctx.stats.read(request)).toMatchObject({ view: { complete: false } })
  const service = ctx.stats
  await ctx.loader.resolve(entry).fiber?.dispose()
  expect(ctx.get('stats')).toBeUndefined()
  await expect(service.read(request)).rejects.toMatchObject({ code: 'stats/unavailable' })
})
