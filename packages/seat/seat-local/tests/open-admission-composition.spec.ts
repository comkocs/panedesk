/** Local openings retain distinct identities and budget-stopped wake receipts. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { recordCost } from './ledger-call.ts'

it('limits concurrent remote openings to two distinct durable windows', async () => {
  const f = await admissionHost()
  try {
    await f.seats.save({ definition: { ...f.definition, maxOpenSessions: 2 },
      expectedRevision: 2, operationId: operation('capacity') })
    const remote = f.ctx.seats.withAuthority({ ...f.authority, origin: 'remote' })
    const started = performance.now()
    const results = await Promise.all(['open-a', 'open-b', 'open-c'].map(id => remote.open({
      seat: f.definition.seat, origin: 'remote', operationId: operation(id),
    })))
    const opened = results.filter(result => result.status === 'opened')
    expect(opened).toHaveLength(2)
    expect(new Set(opened.map(result => result.sessionId)).size).toBe(2)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([
      { error: { code: 'seat-already-open' } },
    ])
    expect(f.engine.journal.projection.resources.size).toBe(2)
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(2)
    process.stdout.write(`${JSON.stringify({ name: 'concurrent-openings', milliseconds: performance.now() - started })}\n`)
  } finally { await f.close() }
})

it('retains a budget-stopped wake without starting another model turn', async () => {
  const f = await admissionHost()
  try {
    await f.seats.save({ definition: { ...f.definition, wakeTemplate: { kind: 'text', text: 'Continue the assigned work.' } },
      expectedRevision: 2, operationId: operation('wake-template') })
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () => f.seats.open({
      seat: f.definition.seat, origin: 'manual', operationId: operation('opening'),
    }))
    if (opened.status !== 'opened') throw new Error('Window did not open')
    await f.engine.drive()
    expect(await f.engine.configureBudget({ sessionId: opened.sessionId,
      limits: { windowBudgetUsd: '100' as T.MicroUsd }, expectedRevision: 0,
      authorizationRef: 'user-a' as T.AuthorizationRef, operationId: operation('budget') })).toMatchObject({ status: 'configured' })
    await recordCost(f.ctx, opened.sessionId, 'cost-a', '0.0001')
    expect(await f.engine.admitTurn(opened.sessionId)).toEqual({ status: 'defer', reason: 'budget-stopped' })
    const started = performance.now()
    const wake = await f.seats.wake({ seat: f.definition.seat, sessionId: opened.sessionId, operationId: operation('wake') })
    expect(wake).toMatchObject({ status: 'stored-budget-stopped' })
    if (wake.status !== 'stored-budget-stopped') throw new Error('Wake was not stored')
    expect(await f.ctx.messageDelivery.status(wake.messageId)).toMatchObject({ state: 'queued' })
    process.stdout.write(`${JSON.stringify({ name: 'budget-stopped-wake', milliseconds: performance.now() - started })}\n`)
  } finally { await f.close() }
})
