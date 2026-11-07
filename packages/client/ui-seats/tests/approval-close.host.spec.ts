/** The owner UI entry closes an actual tool-approval-paused seat turn. */
import { expect, it } from 'vitest'
import { approvalHost } from '../../../seat/seat-local/tests/approval-fixture.ts'
import { operation } from '../../../seat/seat-local/tests/fixtures.ts'
import SeatUi from '../src/index.ts'

it('closes a pending approval through the seat UI', async () => {
  const f = await approvalHost()
  try {
    f.ctx.loader.builtins.seatUi = SeatUi
    await f.load('approval-seat-ui.yml', [{ name: 'cordis:seatUi', config: {} }])
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
    const ui: unknown = f.ctx.get('seatUi')
    if (!(ui instanceof SeatUi)) throw new Error('Seat UI service unavailable')
    expect(f.window.status).toBe('approval-pending')
    const result = await ui.close({ sessionId: f.agent.id, expectedStateVersion: f.window.stateVersion, operationId: operation('ui-approval-close') })
    expect(result.status).toBe('closed')
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.agent.id)
    const closed = (await f.state.read()).effects.find(effect => effect.kind === 'window/closed')
    expect(closed).toMatchObject({ data: { reason: 'manual', detail: 'approval-pending-cancelled' } })
  } finally { await f.close() }
}, 30000)
