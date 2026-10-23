/** Public list, rename and wake results share the committed Session title. */
import { expect } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import type { engineFixture } from './engine-fixture.ts'
import type { CreationAdapter } from './creation-provider.ts'
import { operation } from './fixtures.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'

/** Check title echoes and original manual source replay without a second model request.
 * @param f - installed real local service and engine.
 * @param sessionId - bound window owner.
 * @param adapter - deterministic external model transport.
 */
export async function checkWindowEcho(f: Awaited<ReturnType<typeof engineFixture>>, sessionId: SessionId,
  adapter: CreationAdapter): Promise<void> {
  const seats = f.ctx.get('seats')?.withAuthority({ principalId: 'echo-owner' as T.SeatPrincipalId,
    origin: 'manual', nodeId: f.options.nodeId })
  if (!seats) throw new Error('Seat service is unavailable')
  expect(await seats.rename({ sessionId, title: 'Pinned window', operationId: operation('echo-rename') }))
    .toMatchObject({ status: 'renamed', title: { title: 'Pinned window' } })
  expect(await seats.list({})).toMatchObject({ status: 'listed', sessions: [{ sessionId, title: 'Pinned window' }] })
  const before = adapter.requests.length
  const wake = { seat: f.definition.seat, sessionId, operationId: operation('echo-wake') }
  const sent = await completesTurn(f.ctx, sessionId, inputContains(`Continue ${f.definition.seat}`), () => seats.wake(wake))
  expect(sent).toMatchObject({ status: 'sent', sessionId, title: 'Pinned window' })
  expect(adapter.requests).toHaveLength(before + 1)
  await f.ctx.agents.get(sessionId)?.whenIdle()
  expect(await seats.wake(wake)).toEqual(sent)
  expect(adapter.requests).toHaveLength(before + 1)
  const request = { seat: f.definition.seat, operationId: operation('open-a'), origin: 'manual' as const }
  expect(await seats.open(request)).toMatchObject({ status: 'opened', sessionId })
  expect(await seats.open({ ...request, taskId: 'changed-task' as T.SeatTaskId }))
    .toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
  const facts = (await f.state.read()).effects.filter(effect => effect.kind === 'trigger/accepted'
    && effect.data.trigger.evidence.kind === 'manual' && effect.data.trigger.evidence.operationId === request.operationId)
  expect(facts).toHaveLength(1)
  expect(facts[0]?.data).toMatchObject({ trigger: { evidence: { kind: 'manual', origin: 'manual', operationId: request.operationId } } })
}
