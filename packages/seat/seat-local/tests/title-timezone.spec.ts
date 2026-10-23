/** Controlled UTC midnight boundaries use the node policy clock's configured zone. */
import { expect, it, vi } from 'vitest'
import * as Gates from '../../seat-gates/src/index.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

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
