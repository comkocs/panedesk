/** Manual callbacks follow frozen trusted references through the real Loader and engine. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import type { StreamChunk } from '@panedesk/dsh-llm'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'

const reference: T.OpeningContextReference = { providerId: 'manual-provider' as T.OpeningProviderId,
  reference: 'task-a' as T.OpeningContextReference['reference'], revision: '1' }
const taskId = 'task-a' as T.SeatTaskId

it.each(['prefill', 'auto'] as const)('routes trusted %s opening and preserves replay identity', async (openingMode) => {
  const f = await admissionHost()
  const received: T.SeatCallbackPayload[] = []
  const operations: T.SeatOperationId[] = []
  let calls = 0
  f.adapter.stream = async function* (): AsyncIterable<StreamChunk> {
    calls++
    throw new Error('manual-first-turn-failed')
  }
  const contexts = f.ctx.get('seatOpeningContexts')!
  const release = contexts.register({ providerId: reference.providerId,
    resolve: async () => ({ reference, text: 'Trusted opening', digest: digest('Trusted opening'), revision: '1',
      taskIds: [taskId], scopeEvidence: [] }),
    callback: async (payload, context) => {
      expect(context.reference).toEqual(reference)
      received.push(payload)
      operations.push(context.operationId)
    } })
  try {
    const request: T.OpenSeatWithContextRequest = { seat: f.definition.seat, operationId: operation(`manual-${openingMode}`),
      origin: 'manual', openingMode, openingContext: reference, relatedTaskIds: [taskId], taskId }
    const first = await contexts.open(request, f.authority)
    expect(first.status).toBe(openingMode === 'prefill' ? 'prefilled' : 'opened')
    await vi.waitFor(async () => {
      await f.engine.drive()
      expect(received.map(payload => payload.kind)).toEqual(openingMode === 'prefill' ? ['opened'] : ['opened', 'opening-failed'])
    }, { timeout: 10000 })
    expect(await contexts.open(request, f.authority)).toMatchObject({ status: first.status })
    expect(await contexts.open({ ...request, openingMode: openingMode === 'prefill' ? 'auto' : 'prefill' }, f.authority))
      .toMatchObject({ error: { code: 'operation-id-conflict' } })
    for (let i = 0; i < 3; i++) await f.engine.drive()
    expect(received.filter(payload => payload.kind === 'opened')).toHaveLength(1)
    expect(calls).toBe(openingMode === 'prefill' ? 0 : 1)
    expect(operations.every(id => id === request.operationId)).toBe(true)
    if (!('sessionId' in first)) throw new Error('Missing created session')
    expect(await contexts.open({ ...request, operationId: operation('switch'),
      existingChoice: { kind: 'switch', sessionId: first.sessionId } }, f.authority)).toMatchObject({ status: 'switched' })
    await contexts.wake!({ seat: f.definition.seat, operationId: operation('wake-existing'),
      openingContext: reference, relatedTaskIds: [taskId] }, f.authority)
    await f.engine.drive()
    expect(received.filter(payload => payload.kind === 'opened')).toHaveLength(1)
  } finally { await release(); await f.close() }
}, 15000)

it('retains undelivered callbacks across provider disposal and reload', async () => {
  const f = await admissionHost()
  const callback = vi.fn(async (_payload: T.SeatCallbackPayload) => {})
  const resolve = async (): Promise<T.OpeningContextSnapshot> => ({ reference, text: 'Retained opening',
    digest: digest('Retained opening'), revision: '1', taskIds: [taskId], scopeEvidence: [] })
  let release = f.ctx.get('seatOpeningContexts')!.register({ providerId: reference.providerId, resolve,
    callback: async () => { throw new Error('Receiver temporarily unavailable') } })
  try {
    const request: T.OpenSeatWithContextRequest = { seat: f.definition.seat, operationId: operation('retry-provider'),
      origin: 'manual', openingMode: 'prefill', openingContext: reference, relatedTaskIds: [taskId] }
    expect(await f.ctx.get('seatOpeningContexts')!.open(request, f.authority)).toMatchObject({ status: 'prefilled' })
    await release()
    await f.reload()
    await f.engine.drive()
    expect([...f.engine.journal.projection.callbacks.values()].some(item => item.phase === 'retry-due')).toBe(true)
    release = f.ctx.get('seatOpeningContexts')!.register({ providerId: reference.providerId, resolve, callback })
    await vi.waitFor(async () => { await f.engine.drive(); expect(callback).toHaveBeenCalledTimes(1) }, { timeout: 10000 })
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ kind: 'opened' })
    await f.engine.drive()
    expect(callback).toHaveBeenCalledTimes(1)
  } finally { await release(); await f.close() }
}, 15000)

it('keeps unreferenced manual openings on the empty callback path', async () => {
  const f = await admissionHost()
  const callback = vi.fn(async (_payload: T.SeatCallbackPayload) => {})
  const release = f.ctx.get('seatOpeningContexts')!.register({ providerId: reference.providerId,
    resolve: async () => { throw new Error('Unreferenced provider must not resolve') }, callback })
  try {
    expect(await f.seats.open({ seat: f.definition.seat, operationId: operation('plain-manual'),
      origin: 'manual', openingMode: 'prefill' })).toMatchObject({ status: 'prefilled' })
    await f.engine.drive()
    expect(callback).not.toHaveBeenCalled()
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await release(); await f.close() }
})
