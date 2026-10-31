/** Revision-fenced recovery preserves first-choice state and durable reader compatibility. */
import { afterEach, expect, it } from 'vitest'
import type { SeatOperationId } from '@panedesk/dsh-seat'
import { canonical, decodeFrame, frame } from '../src/journal.ts'
import { fact } from '../src/triggers.ts'
import { harness, projectId, config, nodeId, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('resets only its own committed revision and replays the unchosen state after restart', async () => {
  const h = await harness(); cleanups.push(h.close)
  await h.engine.setProjectMode({ projectId, mode: 'auto', expectedRevision: 0, operationId: 'select' as SeatOperationId })
  expect(await h.engine.resetProjectMode({ projectId, mode: 'remind', modeChosen: false, expectedRevision: 0,
    operationId: 'stale-reset' as SeatOperationId })).toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
  expect(await h.engine.resetProjectMode({ projectId, mode: 'remind', modeChosen: false, expectedRevision: 1,
    operationId: 'reset' as SeatOperationId })).toMatchObject({ status: 'saved', policy: { modeChosen: false, revision: 2 } })
  await h.engine.shutdown()
  const restarted = await h.start()
  expect(await restarted.projectPolicy(projectId)).toEqual({ projectId, mode: 'remind', modeChosen: false, revision: 2 })
})

it('reads old choices and explicit resets but rejects an unmarked unchosen frame', () => {
  const encode = (modeChosen: boolean, reset?: true) => canonical(frame({ namespace: 'ledger/engine/v1', schemaVersion: 1,
    decisionId: 'policy-decision' as import('@panedesk/dsh-seat').EngineDecisionId, sequence: 1, nodeId,
    observedAt: '2026-01-01T00:00:00.000Z', policyRevision: 0,
    effects: [fact({ kind: 'mode/changed', data: { policy: { projectId, mode: 'remind', modeChosen, revision: 1 },
      previousMode: 'auto', previousRevision: 0, principalId: 'engine-policy' as import('@panedesk/dsh-seat').SeatPrincipalId,
      ...(reset ? { reset } : {}) } })] }))
  expect(decodeFrame(encode(true), config.maxDecisionBytes).effects[0]).toMatchObject({ data: { policy: { modeChosen: true } } })
  expect(() => decodeFrame(encode(false), config.maxDecisionBytes)).toThrow('Invalid engine effect')
  expect(decodeFrame(encode(false, true), config.maxDecisionBytes).effects[0])
    .toMatchObject({ data: { reset: true, policy: { modeChosen: false } } })
})

it.each(['off', 'remind', 'auto'] as const)('commits inherited %s with admission and preserves it after restart without a resolver', async (mode) => {
  const h = await harness(); cleanups.push(h.close)
  h.engine.registerProjectPolicyResolver(() => mode)
  const result = await h.engine.accept(trigger())
  expect(result.status).toBe(mode === 'off' ? 'rejected' : 'accepted')
  const decisions = h.engine.journal.projection.decisions
  expect(decisions.some(decision => decision.effects.some(effect => effect.kind === 'mode/changed')
    && decision.effects.some(effect => effect.kind === (mode === 'off' ? 'source/rejected' : 'trigger/accepted')))).toBe(true)
  await h.engine.shutdown()
  const restarted = await h.start()
  expect(await restarted.projectPolicy(projectId)).toMatchObject({ mode, modeChosen: true, revision: 1 })
})

it('does not overwrite an explicit project choice or replace a live resolver', async () => {
  const h = await harness(); cleanups.push(h.close)
  await h.engine.setProjectMode({ projectId, mode: 'off', expectedRevision: 0, operationId: 'explicit' as SeatOperationId })
  h.engine.registerProjectPolicyResolver(() => 'auto')
  expect(() => h.engine.registerProjectPolicyResolver(() => 'remind')).toThrow('already registered')
  expect(await h.engine.accept(trigger())).toMatchObject({ status: 'rejected', error: { code: 'disabled' } })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'off', modeChosen: true, revision: 1 })
})

it('refuses unresolved saved choices without committing policy or pending work', async () => {
  const h = await harness(); cleanups.push(h.close)
  h.engine.registerProjectPolicyResolver(() => { throw new Error('Conflicting workspace choices') })
  expect(await h.engine.accept(trigger())).toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 0 })
  expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
})

it('withdraws synchronous default policy resolution when its registration is disposed', async () => {
  const h = await harness(); cleanups.push(h.close)
  const unregister = h.engine.registerProjectPolicyResolver(() => 'off')
  unregister()
  expect(await h.engine.accept(trigger())).toMatchObject({ status: 'accepted' })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 0 })
})
