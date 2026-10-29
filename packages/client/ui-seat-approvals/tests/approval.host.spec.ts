/** Real transactional engine evidence behind the owner-only UI adapter. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Seat from '@panedesk/dsh-seat'
import SeatApprovals from '../src/index.ts'
import { harness, trigger } from '../../../seat/seat-engine/tests/fixtures.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(enabled = true) {
  const h = await harness(); cleanups.push(h.close)
  const remote = new SeatApprovals(h.ctx, { enabled, pageSize: 10, pollIntervalMs: 1 })
  Object.defineProperty(h.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  await h.engine.accept({ ...trigger(), taskId: 'task-a' as Seat.SeatTaskId })
  const pending = (await h.engine.pending({ limit: 10 })).items[0]!
  return { ...h, remote, request: { queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'approval-a' as Seat.SeatOperationId } }
}

it('records version-bound approval and observes actual opening instead of inventing a receipt', async () => {
  const h = await setup()
  expect(await h.remote.approve(h.request)).toMatchObject({ status: 'approved' })
  const controller = new AbortController()
  const stream = h.remote.watchOperation({ operationId: h.request.operationId }, controller.signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ status: 'pending', approval: { queueItemId: h.request.queueItemId } })
  await h.engine.drive()
  const step = await stream.next()
  if (step.done) throw new Error('Expected operation observation')
  const result = step.value
  expect(result).toMatchObject({ status: 'settled', result: { status: 'opened', seat: 'seat-a', nodeId: 'node-a', budget: {} } })
  if (!result || result.status !== 'settled' || result.result.status !== 'opened') throw new Error('Expected opened evidence')
  if (!('title' in result.result)) throw new Error('Expected direct opened evidence')
  expect(result.result.title).toBeTruthy()
  controller.abort(); await stream.return?.()
  expect(h.engine.journal.projection.authorizationDecisions.some(frame => frame.effects.some(effect =>
    effect.kind === 'authorization/checked' && effect.data.kind === 'local-operator' && effect.data.seat === 'seat-a'
      && effect.data.taskIds.includes('task-a' as Seat.SeatTaskId)))).toBe(true)
})

it('returns a stale version refusal without creating a window', async () => {
  const h = await setup()
  expect(await h.remote.approve({ ...h.request, expectedStateVersion: h.request.expectedStateVersion - 1 }))
    .toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
  expect(h.creates).toEqual([])
})

it('reports opening failure after approval without presenting success', async () => {
  const h = await setup()
  h.state.opening = 'failed'
  expect(await h.remote.approve(h.request)).toMatchObject({ status: 'approved' })
  await h.engine.drive()
  const stream = h.remote.watchOperation({ operationId: h.request.operationId }, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ status: 'settled', result: { status: 'rejected' } })
  await stream.return?.()
})

it('cancels through the audited engine capability and keeps disabled or non-owner calls inert', async () => {
  const h = await setup()
  expect(await h.remote.cancel(h.request)).toMatchObject({ status: 'cancelled' })
  expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'guest' } } } })
  expect(() => h.remote.approve(h.request)).toThrow('Authenticated owner')
  const disabled = await setup(false)
  const stream = disabled.remote.watchPending(new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ enabled: false, items: [], complete: true })
  expect(() => disabled.remote.cancel(disabled.request)).toThrow('not enabled')
  await stream.return?.()
})

it('does not admit work after the owner invocation is cancelled', async () => {
  const h = await setup()
  const controller = new AbortController()
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: controller.signal } })
  controller.abort()
  expect(() => h.remote.approve(h.request)).toThrow('not enabled')
  expect(h.creates).toEqual([])
  expect((await h.engine.pending({ limit: 10 })).items).toHaveLength(1)
})

it('loads the opt-in adapter through a real Loader and withdraws its service', async () => {
  const h = await harness(); cleanups.push(h.close)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(h.home).href}/`
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, approvals: SeatApprovals })
  const profile = join(h.home, 'cordis.yml')
  await writeFile(profile, JSON.stringify([{ name: 'cordis:approvals', config: { enabled: false, pollIntervalMs: 1, pageSize: 10 } }]))
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  expect(ctx.get('seatApprovals')).toBeDefined()
  const stream = ctx.get('seatApprovals')!.watchPending(new AbortController().signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ enabled: false, items: [] })
  await stream.return?.()
  await ctx.loader.resolve(entry).fiber?.dispose()
  expect(ctx.get('seatApprovals')).toBeUndefined()
})
