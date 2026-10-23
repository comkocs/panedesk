import { afterEach, expect, it } from 'vitest'
import type { LedgerCall, LedgerCallStart, LedgerCallFinish, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { budgetLevel, dayKey, microUsd, projectBudget } from '../src/budget.ts'
import { auto, budget, harness, seat, trigger } from './fixtures.ts'

function call(sessionId: SessionId, cost?: string, purpose: LedgerCallStart['purpose'] = 'conversation'): LedgerCall {
  const start: LedgerCallStart = { callId: 'call-a' as LedgerCallStart['callId'], runId: 'run-a' as LedgerCallStart['runId'],
    logicalRequestId: 'request-a' as LedgerCallStart['logicalRequestId'], sessionId, rootSessionId: sessionId,
    nodeId: 'node-a' as LedgerCallStart['nodeId'], seat, window: 'window-a', identitySource: 'settings', accountLabel: 'account-a',
    attemptIndex: 0, attemptVisibility: 'physical', provider: 'provider-a', modelFamily: 'family-a', requestedModel: 'model-a', purpose,
    startedAt: Date.now(), cache: { breakReasons: [], cacheMode: 'unknown' }, cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' },
    priceVersion: 'test-v1', priceKey: 'model-a', referencePrice: true }
  const finish: LedgerCallFinish = { callId: start.callId, endedAt: Date.now(), observedAt: Date.now(), responseModelReported: 'not-reported',
    effectiveModel: 'model-a', usageState: 'missing', pricingState: 'missing-usage', wallMs: 1, modelInFlightMs: 1, queueMs: 0, backoffMs: 0,
    waits: [], compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false, ...(cost === undefined ? {} : { costUsd: cost }) }
  return { kind: 'call', start, finish }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it('A17 uses exact micro costs and distinguishes unknown evidence from zero', () => {
  expect(microUsd('0.0000001')).toBe('1')
  expect(microUsd('123456789.123456')).toBe('123456789123456')
  expect(budgetLevel({ ...budget(), limits: { windowBudgetUsd: '100' as T.MicroUsd }, windowCost: '80' as T.MicroUsd })).toBe('warning')
  expect(budgetLevel({ ...budget(), limits: { windowBudgetUsd: '100' as T.MicroUsd }, costState: 'unknown' })).toBe('unverifiable')
})
it('A17 sends one steer warning and stops only new turns with a complete budget callback', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: trigger().sourceId }, timeWindows: [], exclusiveTags: [], windowBudgetUsd: '100' as T.MicroUsd }]
  await h.engine.accept(trigger()); await h.engine.drive()
  const sessionId = h.creates[0]!
  h.state.snapshot = { asOf: 2, watermarks: {}, complete: true, rows: [call(sessionId, '0.00008')] }
  await h.engine.drive(); await h.engine.drive()
  expect(h.warnings).toHaveLength(1)
  expect(h.warnings[0]).toMatchObject({ sessionId, messageClass: 'handoff', mode: 'steer' })
  expect(await h.engine.admitTurn(sessionId)).toEqual({ status: 'allow' })
  const inbox = ['next input'], completedSteps: string[] = []
  let continueTurn!: () => void
  const turnPaused = new Promise<void>((resolve) => { continueTurn = resolve })
  const currentTurn = (async () => {
    if ((await h.engine.admitTurn(sessionId)).status !== 'allow') return
    completedSteps.push('model')
    await turnPaused
    completedSteps.push('tool', 'final-model')
  })()
  await Promise.resolve(); await new Promise(resolve => setImmediate(resolve))
  h.state.snapshot = { ...h.state.snapshot, rows: [call(sessionId, '0.0001')] }
  await h.engine.drive()
  const nextTurn = await h.engine.admitTurn(sessionId)
  if (nextTurn.status === 'allow') inbox.shift()
  continueTurn(); await currentTurn
  expect(completedSteps).toEqual(['model', 'tool', 'final-model'])
  expect(inbox).toEqual(['next input'])
  expect(nextTurn).toEqual({ status: 'defer', reason: 'budget-stopped' })
  expect(h.callbacks.find(payload => payload.kind === 'budget-stopped')).toMatchObject({ sessionId, seat, budgetSnapshot: { windowCost: '100', costState: 'known' } })
  expect(h.engine.journal.projection.decisions.flatMap(d => d.effects).filter(e => e.kind === 'budget/warning')).toHaveLength(1)
})
it('A17 retains a daily-full request without creating or reserving a new window', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  h.definitions.get(seat)!.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
    trigger: { kind: 'external', sourceId: trigger().sourceId }, timeWindows: [], exclusiveTags: ['resource-a'],
    dailyBudgetUsd: '100' as T.MicroUsd }]
  h.state.snapshot = { asOf: 2, watermarks: {}, complete: true, rows: [call('earlier-window' as SessionId, '0.0001')] }
  await h.engine.accept(trigger()); await h.engine.drive()
  expect(h.creates).toEqual([])
  expect(h.engine.journal.projection.resources.size).toBe(0)
  expect((await h.engine.pending({ limit: 10 })).items).toEqual([expect.objectContaining({ reason: 'budget-full', seat })])
})
it('A17 includes descendants and keepalive while late settlement stays on its original day', () => {
  const sessionId = budget().sessionId, parent = call(sessionId, '0.00002'), child = call('child-a' as SessionId, '0.00003'), keepalive = call(sessionId, '0.00004', 'keepalive')
  child.start = { ...child.start, rootSessionId: sessionId, callId: 'child-call' as LedgerCallStart['callId'] }
  keepalive.start = { ...keepalive.start, callId: 'keepalive-call' as LedgerCallStart['callId'] }
  parent.start = { ...parent.start, startedAt: Date.parse('2026-01-01T23:59Z') }
  const snapshot: LedgerSnapshot = { asOf: 3, watermarks: {}, complete: true, rows: [parent, child, keepalive, child] }
  const projected = projectBudget(snapshot, { sessionId, seat, limits: {}, budgetRevision: 0, budgetTimeZone: 'UTC', now: Date.now() })
  expect(projected.windowCost).toBe('90'); expect(projected.dailyCost).toBe('70')
  expect(dayKey(parent.start.startedAt, 'UTC')).toBe('2026-01-01')
  delete child.finish
  expect(projectBudget(snapshot, { sessionId, seat, limits: {}, budgetRevision: 0, budgetTimeZone: 'UTC', now: Date.now() }).costState).toBe('unknown')
})
