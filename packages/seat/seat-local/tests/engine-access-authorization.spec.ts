/** Real Loader composition persists invocation-owned attribution with local opening admission. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it('records model tool opening attribution in the acceptance frame and retains it across local reload', async () => {
  const f = await admissionHost()
  try {
    const caller = await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('caller-a'), openingMode: 'prefill' })
    if (caller.status !== 'prefilled') throw new Error('Expected a caller window')
    const agent = f.ctx.get('agents')!.get(caller.sessionId)!
    const target = { ...f.definition, seat: 'seat-b' as T.SeatName }
    expect(await f.seats.save({ definition: target, expectedRevision: 2, operationId: operation('save-b') })).toMatchObject({ status: 'saved' })
    const callId = 'call-a' as T.SeatModelToolAuthority['callId']
    const access = f.ctx.get('seatLocalWindows')!.forInvocation({ session: agent.session, callId })
    const taskId = 'task-a' as T.SeatTaskId
    const result = await access.open({ seat: target.seat, origin: 'manual', operationId: operation('ignored-client-id'), openingMode: 'prefill', taskId })
    expect(result).toMatchObject({ status: 'prefilled' })
    const query = { taskId, seat: target.seat, kind: 'model-tool-call' as const, limit: 10 }
    const before = await f.engine.authorizations.query(query)
    expect(before).toMatchObject({ facts: [{ kind: 'model-tool-call', sessionId: agent.id, callId,
      operationId: `tool:${agent.id}:${callId}`, taskIds: [taskId] }], complete: true })
    const decision = f.engine.journal.projection.authorizationDecisions.find(item => item.effects.some(effect => effect.kind === 'authorization/checked'))!
    expect(decision.effects.map(effect => effect.kind)).toEqual(['trigger/accepted', 'authorization/checked'])
    expect(await f.ctx.get('seatAuthorizationQueries')!.query(query)).toEqual(before)
    await f.reload()
    const after = await f.engine.authorizations.query(query)
    if ('status' in before || 'status' in after) throw new Error('Expected authorization queries')
    expect(after.facts).toEqual(before.facts)
    expect(after.watermark).toBeGreaterThanOrEqual(before.watermark)
    await expect(access.open({ seat: target.seat, origin: 'manual', operationId: operation('revoked') })).rejects.toThrow('live session')
  } finally { await f.close() }
})
