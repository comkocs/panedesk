/** Node observations and writes reuse the running host's providers. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Seat from '@panedesk/dsh-seat'
import { harness } from '../../../seat/seat-engine/tests/fixtures.ts'
import Nodes from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const config = { enabled: true, refreshIntervalMs: 1000, pageSize: 10 }
function setup(enabled = true) {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  const controller = new AbortController()
  Object.defineProperty(ctx, 'invocation', { configurable: true,
    value: { peer: { principal: { kind: 'owner' } }, signal: controller.signal } })
  const nodes = new Nodes(ctx, { ...config, enabled })
  return { ctx, nodes, controller }
}
it('reports disabled and cancelled reads without starting an engine', async () => {
  const disabled = setup(false)
  await expect(disabled.nodes.read()).rejects.toMatchObject({ code: 'nodes/disabled' })
  const h = setup(); h.controller.abort()
  await expect(h.nodes.read()).rejects.toMatchObject({ code: 'nodes/unavailable' })
  expect(h.ctx.get('seatEngine')).toBeUndefined()
})
it('passes source resolution to installed providers and only rebuilds the selected peer', async () => {
  const h = await harness(); cleanups.push(h.close)
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  const nodes = new Nodes(h.ctx, config)
  const rebuild = vi.fn(async () => ({ status: 'rebuilt' as const }))
  h.ctx.provide('hostAdminTransport', { rebuildTransport: rebuild })
  const write = vi.fn(async () => ({ status: 'ok' as const }))
  h.ctx.provide('hostAdminSourceOperator', { list: async () => ({ items: [] }), abandon: write, resend: write })
  expect(await nodes.act({ kind: 'rebuild', peerNodeId: 'node-b' as Seat.SeatNodeId })).toEqual({ status: 'ok' })
  expect(rebuild).toHaveBeenCalledExactlyOnceWith('node-b')
  for (const action of ['resume', 'abandon'] as const) {
    expect(await nodes.act({ kind: 'source', action, operationId: action, key: 'original-key', reason: 'Operator reviewed' }))
      .toEqual({ status: 'ok' })
  }
  expect(write).toHaveBeenCalledTimes(2)
  expect(await nodes.act({ kind: 'callback', request: { callbackId: 'missing' as Seat.CallbackId, action: 'resume', expectedAttempt: 0 } }))
    .toEqual({ status: 'rejected', code: 'callback-unknown' })
})
it('rejects malformed operator parameters before any installed provider is called', async () => {
  const h = setup()
  const rebuild = vi.fn(async () => ({ status: 'rebuilt' as const }))
  h.ctx.provide('hostAdminTransport', { rebuildTransport: rebuild })
  expect(await h.nodes.act({ kind: 'rebuild', peerNodeId: '' as Seat.SeatNodeId }))
    .toEqual({ status: 'rejected', code: 'admin-request-invalid' })
  expect(await h.nodes.act({ kind: 'callback', request: {
    callbackId: 'callback-a' as Seat.CallbackId, action: 'resume', expectedAttempt: -1,
  } })).toEqual({ status: 'rejected', code: 'admin-request-invalid' })
  expect(await h.nodes.act({ kind: 'source', action: 'resume', operationId: 'operation-a', key: 'key', reason: '' }))
    .toEqual({ status: 'rejected', code: 'admin-request-invalid' })
  expect(rebuild).not.toHaveBeenCalled()
})
it('loads from a file-backed Loader and withdraws the settings namespace on disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-settings-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(home).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, nodes: Nodes })
  const profile = join(home, 'cordis.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:nodes', config }]))
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  expect(await ctx.nodes.read()).toMatchObject({ view: { nodes: [], callbacksAvailable: false } })
  const nodes = ctx.nodes
  await ctx.loader.resolve(entry).fiber?.dispose()
  expect(ctx.get('nodes')).toBeUndefined()
  await expect(nodes.read()).rejects.toMatchObject({ code: 'nodes/unavailable' })
})
