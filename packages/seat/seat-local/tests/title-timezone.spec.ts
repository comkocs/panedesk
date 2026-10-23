/** Controlled UTC midnight boundaries use the node policy clock's configured zone. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { trigger } from '../../seat-engine/tests/fixtures.ts'
import * as Gates from '../../seat-gates/src/index.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { engineFixture } from './engine-fixture.ts'

it('dates automatic and manual opening titles alike across node midnight', async () => {
  const f = await admissionHost()
  const envelope = trigger()
  let unregister: (() => Promise<void>) | undefined
  try {
    f.ctx.loader.builtins.gates = Gates
    await f.load('timezone-gates.yml', [{ name: 'cordis:gates', config: { timeZone: 'Asia/Shanghai' } }])
    expect(await f.seats.save({ definition: { ...f.definition, maxOpenSessions: 2, rules: [{
      id: 'rule-a' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: envelope.sourceId },
      mode: 'auto', timeWindows: [], exclusiveTags: [],
    }] }, expectedRevision: 2, operationId: operation('save-auto-timezone') })).toMatchObject({ status: 'saved' })
    expect(await f.engine.setProjectMode({ projectId: f.definition.projectId, mode: 'auto', expectedRevision: 0,
      operationId: operation('auto-timezone') })).toMatchObject({ status: 'saved' })
    unregister = f.engine.registerSource({ sourceId: envelope.sourceId, kinds: ['external'], maxRedeliveryMs: null,
      callback: async () => {} })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T16:00:00.000Z'))
    const manual = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () => f.seats.open({
      seat: f.definition.seat, origin: 'manual', operationId: operation('manual-auto-timezone'),
    }))
    expect(manual).toMatchObject({ status: 'opened', title: 'seat-a 10-24' })
    if (manual.status !== 'opened') throw new Error('Manual window did not open')
    await completesTurn(f.ctx, id => id !== manual.sessionId, inputContains('Open seat-a'), async () => {
      expect(await f.engine.accept(envelope)).toMatchObject({ status: 'accepted' })
      await f.engine.drive()
    })
    const automatic = [...f.engine.journal.projection.opens.values()].find(open => open.sessionId !== manual.sessionId)
    expect(automatic).toMatchObject({ title: manual.title })
    if (!automatic) throw new Error('Automatic window did not open')
    expect(f.ctx.sessionTitle.get(f.ctx.sessions.get(automatic.sessionId)!)).toMatchObject({ title: manual.title })
    expect(automatic.frozenOpening?.text).toContain('2026-10-23')
  } finally {
    vi.useRealTimers()
    await unregister?.()
    await f.close()
  }
}, 15000)

it.each([
  { zone: 'Asia/Shanghai', suffix: '10-24' },
  { zone: undefined, suffix: '10-23' },
])('dates fallback titles without local access in the node policy zone: $zone', async ({ zone, suffix }) => {
  const f = await engineFixture()
  const envelope = trigger()
  try {
    if (zone) f.ctx.provide('seatGates', { getTimeZone: () => zone } as T.SeatGateService)
    f.engine.registerSource({ sourceId: envelope.sourceId, kinds: ['external'], maxRedeliveryMs: null,
      callback: async () => {} })
    await f.engine.setProjectMode({ projectId: f.definition.projectId, mode: 'auto', expectedRevision: 0,
      operationId: operation('fallback-timezone') })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T16:00:00.000Z'))
    expect(await f.engine.accept(envelope)).toMatchObject({ status: 'accepted' })
    await f.engine.drive()
    expect(f.created).toHaveLength(1)
    expect(f.created[0]).toMatchObject({ title: `seat-a ${suffix}` })
  } finally {
    vi.useRealTimers()
    await f.close()
  }
}, 15000)

it.each([
  { zone: 'Asia/Shanghai', suffix: '10-24' },
  { zone: 'UTC', suffix: '10-23' },
  { zone: undefined, suffix: '10-23' },
])('dates a window in the node policy zone: $zone', async ({ zone, suffix }) => {
  const f = await admissionHost()
  try {
    f.ctx.loader.builtins.gates = Gates
    await f.load('timezone-gates.yml', [{ name: 'cordis:gates', config: zone === undefined ? {} : { timeZone: zone } }])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T16:30:00.000Z'))
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () => f.seats.open({
      seat: f.definition.seat, origin: 'manual', operationId: operation('open-timezone'),
    }))
    expect(opened).toMatchObject({ status: 'opened', title: `seat-a ${suffix}` })
    if (opened.status !== 'opened') throw new Error('Window did not open')
    expect(f.ctx.sessionTitle.get(f.ctx.sessions.get(opened.sessionId)!)).toMatchObject({ title: opened.title })
    expect(await f.seats.rename({ sessionId: opened.sessionId, title: `seat-a ${suffix}`,
      operationId: operation('rename-timezone') })).toMatchObject({ status: 'renamed', title: { title: opened.title } })
    expect(await f.seats.rename({ sessionId: opened.sessionId, title: 'Pinned window',
      operationId: operation('rename-explicit') })).toMatchObject({ status: 'renamed', title: { title: 'Pinned window' } })
  } finally {
    vi.useRealTimers()
    await f.close()
  }
}, 15000)

it.each([
  { instant: '2026-10-23T15:59:59.000Z', suffix: '10-23' },
  { instant: '2026-10-23T16:00:00.000Z', suffix: '10-24' },
])('dates replacement and opening titles alike at node midnight: $instant', async ({ instant, suffix }) => {
  const f = await admissionHost()
  try {
    f.ctx.loader.builtins.gates = Gates
    await f.load('timezone-gates.yml', [{ name: 'cordis:gates', config: { timeZone: 'Asia/Shanghai' } }])
    expect(f.engine.options.config.budgetTimeZone).toBe('UTC')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () => f.seats.open({
      seat: f.definition.seat, origin: 'manual', operationId: operation('open-before-replacement'),
    }))
    expect(opened).toMatchObject({ status: 'opened', title: `seat-a ${suffix}` })
    if (opened.status !== 'opened') throw new Error('Window did not open')
    await completesTurn(f.ctx, id => id !== opened.sessionId, inputContains('Open seat-a'), async () => {
      expect(await f.seats.replace({ sessionId: opened.sessionId, operationId: operation('replace-timezone') }))
        .toMatchObject({ status: 'queued' })
      await f.engine.drive()
    })
    const next = [...f.engine.journal.projection.replacements.values()][0]?.newSessionId
    if (!next) throw new Error('Replacement Session was not reserved')
    expect(f.engine.journal.projection.opens.get(next)?.title).toBe(opened.title)
    const session = f.ctx.sessions.get(next)
    if (!session) throw new Error('Replacement Session was not created')
    expect(f.ctx.sessionTitle.get(session)).toMatchObject({ title: opened.title })
    expect(session.snapshotEvents().some(event => event.type === 'session/title' && event.data.title === opened.title)).toBe(true)
  } finally {
    vi.useRealTimers()
    await f.close()
  }
}, 15000)
