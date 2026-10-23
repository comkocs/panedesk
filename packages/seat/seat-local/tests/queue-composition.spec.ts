/** Real admission retains FIFO order while queued windows own no exclusive labels. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { engineFixture } from './engine-fixture.ts'
import { admitLocalOpen } from '../src/open-admission.ts'
import { renderOpening } from '../src/template.ts'
import { LocalCloser } from '../src/closing-service.ts'
import { operation } from './fixtures.ts'

it('opens label-blocked local requests in FIFO order after durable owner close', async () => {
  const f = await engineFixture(true)
  const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
  try {
    const definitions = new Map<T.SeatName, T.SeatDefinition>()
    f.dependencies.seats = () => ({ resolve: async (seat) => {
      const definition = definitions.get(seat)
      if (!definition) throw new Error('Test definition is missing')
      return definition
    }, list: async () => ({ status: 'listed', sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() }),
    close: request => closer.close(request) })
    const submit = async (seat: T.SeatName) => {
      const definition = { ...f.definition, seat, rules: [{ id: 'manual-label' as T.SeatRuleId, enabled: true,
        trigger: { kind: 'manual' as const, origin: 'manual' as const }, timeWindows: [], exclusiveTags: ['shared-resource'] }] }
      definitions.set(seat, definition)
      return admitLocalOpen(f.engine, f.state, { request: { seat, origin: 'manual', operationId: operation(seat), openingMode: 'auto' },
        authority: { principalId: 'queue-owner' as T.SeatPrincipalId, nodeId: f.options.nodeId, origin: 'manual' }, definition,
        title: seat, opening: renderOpening('Open {{seat}}', { seat, date: '2026-01-01', taskId: null }, 4096) }, f.options.nodeName)
    }
    const first = await submit('seat-a' as T.SeatName)
    if (first.status !== 'opened') throw new Error('Initial owner did not open')
    expect(await submit('seat-b' as T.SeatName)).toMatchObject({ status: 'queued', reason: 'exclusive-tag' })
    expect(await submit('seat-c' as T.SeatName)).toMatchObject({ status: 'queued', reason: 'exclusive-tag' })
    expect((await f.engine.pending({ limit: 10 })).items.map(item => item.seat)).toEqual(['seat-b', 'seat-c'])
    expect([...f.engine.journal.projection.resources.values()].map(item => item.seat)).toEqual(['seat-a'])
    expect(await closer.close({ sessionId: first.sessionId, operationId: operation('close-first'), expectedStateVersion: 1 })).toMatchObject({ status: 'closed' })
    await f.engine.drive()
    expect([...f.engine.journal.projection.resources.values()].map(item => item.seat)).toEqual(['seat-b'])
    expect((await f.engine.pending({ limit: 10 })).items.map(item => item.seat)).toEqual(['seat-c'])
    const second = f.created.find(open => open.binding.kind === 'seat' && open.binding.seat === 'seat-b')
    if (!second) throw new Error('Second owner was not created')
    expect(await closer.close({ sessionId: second.sessionId, operationId: operation('close-second'), expectedStateVersion: 1 })).toMatchObject({ status: 'closed' })
    await f.engine.drive()
    expect([...f.engine.journal.projection.resources.values()].map(item => item.seat)).toEqual(['seat-c'])
    expect((await f.engine.pending({ limit: 10 })).items).toEqual([])
    expect(f.created.map(open => open.binding.kind === 'seat' ? open.binding.seat : '')).toEqual(['seat-a', 'seat-b', 'seat-c'])
  } finally { await closer.drain(); await f.close() }
})
