import { Context } from '@panedesk/cordis'
import { afterEach, expect, it } from 'vitest'
import * as readerPlugin from '@panedesk/dsh-seat-engine/reader'
import type * as T from '@panedesk/dsh-seat'
import { config, harness, definition, nodeId, seat, sourceId, trigger } from './fixtures.ts'
import { redactPending } from '../src/query.ts'
import { operationHistory } from './operation-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

it('projects the frozen title and matching budget without exposing opening instructions', async () => {
  const h = await harness(); cleanups.push(h.close)
  await h.engine.accept(trigger())
  const retained = [...h.engine.journal.projection.pending.values()][0]!
  const frozen = definition()
  frozen.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId },
    timeWindows: [], exclusiveTags: [], windowBudgetUsd: '2500000' as T.MicroUsd, dailyBudgetUsd: '10000000' as T.MicroUsd }]
  const item = { ...retained, frozenOpen: { definition: frozen, title: 'Review window', openingMode: 'auto' as const } }
  expect(redactPending(item)).toMatchObject({ seat, windowName: 'Review window',
    budget: { windowBudgetUsd: '2500000', dailyBudgetUsd: '10000000' } })
  expect(redactPending(item)).not.toHaveProperty('frozenOpen')
  expect(JSON.stringify(redactPending(item))).not.toContain('Begin the assigned task.')
  expect(redactPending(item)).not.toHaveProperty('nodeId')
  expect(item.frozenOpen.definition).toBe(frozen)
})

it('leaves missing frozen metadata absent and never treats a nonmatching rule as a budget', async () => {
  const h = await harness(); cleanups.push(h.close)
  expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
  await h.engine.accept(trigger())
  const { frozenOpen: _frozenOpen, ...retained } = [...h.engine.journal.projection.pending.values()][0]!
  for (const field of ['windowName', 'nodeId', 'budget']) expect(redactPending(retained)).not.toHaveProperty(field)
  const frozen = definition()
  frozen.rules = [{ id: 'other-rule' as T.SeatRuleId, enabled: true,
    trigger: { kind: 'external', sourceId: 'other-source' as T.SeatSourceId }, timeWindows: [], exclusiveTags: [],
    windowBudgetUsd: '0' as T.MicroUsd }]
  expect(redactPending({ ...retained, frozenOpen: { definition: frozen, title: 'Frozen', openingMode: 'auto' } }))
    .not.toHaveProperty('budget')
  expect(redactPending({ ...retained, windowName: 'Legacy preview', budget: { windowBudgetUsd: '0' as T.MicroUsd } }))
    .toMatchObject({ windowName: 'Legacy preview', budget: { windowBudgetUsd: '0' } })
  frozen.rules[0]!.trigger = { kind: 'external', sourceId }
  expect(redactPending({ ...retained, frozenOpen: { definition: frozen, title: 'Frozen', openingMode: 'auto' } }))
    .toMatchObject({ budget: { windowBudgetUsd: '0' } })
})

it('returns the same frozen metadata in live and offline pending pages', async () => {
  const h = await harness(); cleanups.push(h.close)
  h.engine.registerLocalAccess({ list: () => h.seatProvider.list(), close: request => h.seatProvider.close(request),
    freeze: async definition => ({ definition, title: 'Retained title', openingMode: 'auto' }) })
  await h.engine.accept(trigger())
  const live = await h.engine.pending({ limit: 10 })
  expect(live.items).toHaveLength(1)
  expect(live.items[0]).toMatchObject({ windowName: 'Retained title' })
  await h.engine.shutdown()
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(readerPlugin, { home: h.home, nodeId, maxDecisionBytes: config.maxDecisionBytes })
  expect(await ctx.get('seatEngineQuery')!.pending({ limit: 10 })).toEqual(live)
})

it('projects only the authenticated target retained by a frozen chain', async () => {
  const { pending } = await operationHistory()
  expect(redactPending(pending)).toMatchObject({ windowName: pending.frozenOpen!.title, nodeId: 'node-a' })
  expect(redactPending(pending)).not.toHaveProperty('frozenOpen')
})
