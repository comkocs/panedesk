/** Optional local policy precedes every manual acceptance effect. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { definition, harness, nodeId, seat } from './fixtures.ts'

it('leaves the journal empty on pre-admission refusal and restores legacy opening on disposal', async () => {
  const h = await harness()
  try {
    const refusal: T.SeatRejected = { status: 'rejected', error: { code: 'gate-denied', message: 'Opening blocked.',
      alternative: 'Cancel opening.', retryable: false, effectState: 'none' } }
    let calls = 0
    const remove = h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
      freeze: async () => { throw new Error('unused') }, preAdmit: async () => { calls++; return refusal } })
    const sourceId = 'seat-local-manual' as T.SeatSourceId
    h.engine.registerSource({ sourceId, kinds: ['manual'], maxRedeliveryMs: null, callback: async () => {} })
    const input: T.SeatLocalOpenRequest = {
      request: { seat, origin: 'manual', operationId: 'open-a' as T.SeatOperationId, openingMode: 'prefill' },
      authority: { principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId }, definition: definition(),
      title: 'window-a', opening: { text: 'Opening', digest: 'digest-a' as T.SeatDigest,
        variables: { seat, date: '2026-01-01', taskId: null } },
    }
    expect(await h.engine.openWindow(input)).toBe(refusal)
    expect(calls).toBe(1)
    expect(h.engine.journal.projection.sequence).toBe(0)
    expect(h.engine.journal.projection.decisions).toEqual([])
    expect(h.creates).toEqual([])
    await remove()
    expect(await h.engine.openWindow(input)).toMatchObject({ status: 'prefilled' })
    expect(calls).toBe(1)
    expect(h.creates).toHaveLength(1)
    expect(h.engine.journal.projection.decisions[0]?.effects[0]?.kind).toBe('trigger/accepted')
  } finally { await h.close() }
})
