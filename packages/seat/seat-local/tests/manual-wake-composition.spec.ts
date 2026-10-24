/** Missing-window wakes use trusted opening admission, not a second callback path. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'

it('routes a missing-window wake through its trusted provider exactly once', async () => {
  const f = await admissionHost()
  const contexts = f.ctx.get('seatOpeningContexts')!
  const reference: T.OpeningContextReference = { providerId: 'wake-provider' as T.OpeningProviderId,
    reference: 'wake-task' as T.OpeningContextReference['reference'], revision: '1' }
  const callback = vi.fn(async (_payload: T.SeatCallbackPayload) => {})
  const resolve = vi.fn(async (): Promise<T.OpeningContextSnapshot> => ({ reference, text: 'Trusted wake opening',
    digest: digest('Trusted wake opening'), revision: '1', taskIds: [], scopeEvidence: [] }))
  const release = contexts.register({ providerId: reference.providerId, resolve, callback })
  try {
    const request: T.WakeSeatWithContextRequest = { seat: f.definition.seat, operationId: operation('missing-wake'),
      openingContext: reference, relatedTaskIds: [] }
    expect(await contexts.wake!(request, f.authority)).toMatchObject({ status: 'opened', result: { status: 'opened' } })
    await vi.waitFor(async () => { await f.engine.drive(); expect(callback).toHaveBeenCalledTimes(1) })
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ kind: 'opened' })
    expect(resolve).toHaveBeenCalledTimes(1)
    await contexts.wake!({ ...request, operationId: operation('existing-wake') }, f.authority)
    await f.engine.drive()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
  } finally { await release(); await f.close() }
})
