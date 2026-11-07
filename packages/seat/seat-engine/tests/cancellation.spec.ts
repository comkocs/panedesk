/** Pending cancellation leaves budget and resource projections unchanged. */
import { afterEach, expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function setup() { const h = await harness({ ownerObserveIntervalMs: 60000 }); cleanups.push(h.close); return h }
async function pendingRequest(h: Awaited<ReturnType<typeof harness>>, reason?: string) {
  await h.engine.accept(trigger())
  const pending = (await h.engine.pending({ limit: 10 })).items[0]!
  return { queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: 'cancel-a' as T.SeatOperationId, ...(reason === undefined ? {} : { reason }) }
}
it.each([false, true])('cancels approved=%s work without creating or changing budget and resource projections', async (approved) => {
  const h = await setup(), request = await pendingRequest(h, 'Operator stopped pending work')
  if (approved) {
    await h.engine.approve({ ...request, operationId: 'approve-a' as T.SeatOperationId })
    request.expectedStateVersion++
  }
  const before = { budgets: [...h.engine.journal.projection.budgets], resources: [...h.engine.journal.projection.resources] }
  expect(await h.engine.cancel(request)).toEqual({ status: 'cancelled', queueItemId: request.queueItemId,
    stateVersion: request.expectedStateVersion + 1 })
  await h.engine.shutdown()
  const restarted = await h.start()
  expect((await restarted.pending({ limit: 10 })).items).toEqual([])
  expect({ budgets: [...restarted.journal.projection.budgets], resources: [...restarted.journal.projection.resources] }).toEqual(before)
  await restarted.drive()
  expect(h.creates).toEqual([])
})
it('keeps legacy cancellation replies and absent attribution byte-for-byte', async () => {
  const h = await setup(), request = await pendingRequest(h)
  expect(JSON.stringify(await h.engine.cancel(request))).toBe(JSON.stringify({ status: 'cancelled',
    queueItemId: request.queueItemId, stateVersion: request.expectedStateVersion + 1 }))
  expect(JSON.stringify(await h.engine.cancel(request))).toBe(JSON.stringify({ status: 'rejected', error: {
    code: 'revision-conflict', message: 'Pending state changed', alternative: 'Inspect engine state and retry with the same operation identity.',
    retryable: false, effectState: 'none' } }))
  const effect = h.engine.journal.projection.decisions.at(-1)!.effects[0]!
  expect(effect).toMatchObject({ data: { principalId: 'engine-policy' } })
  expect(effect.data).not.toHaveProperty('cancellation')
})
it('distinguishes unknown, dispatched and opened targets without changing legacy errors', async () => {
  const h = await setup(), request = await pendingRequest(h)
  const unknown = { ...request, queueItemId: 'unknown' as T.QueueItemId }
  expect(await h.engine.cancel(unknown)).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
  await auto(h.engine)
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve }), dispatched = new Promise<void>((resolve) => { started = resolve })
  const create = h.executor.create.bind(h.executor)
  h.executor.create = async (open) => { started(); await blocked; return create(open) }
  const driving = h.engine.drive()
  try {
    await dispatched
    expect(await h.engine.cancel(request)).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
  } finally { release(); await driving }
  expect(await h.engine.cancel(request)).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
})
