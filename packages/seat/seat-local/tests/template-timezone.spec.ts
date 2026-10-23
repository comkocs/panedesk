/** Template dates follow the node clock while accepted opening text remains immutable. */
import { expect, it, vi } from 'vitest'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'
import * as Gates from '../../seat-gates/src/index.ts'
import { formatTemplateDate } from '../src/template.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it.each([
  { zone: 'Asia/Shanghai', date: '2026-10-24' },
  { zone: 'America/Los_Angeles', date: '2026-10-23' },
  { zone: undefined, date: '2026-10-23' },
])('formats template dates as YYYY-MM-DD in the selected zone: $zone', ({ zone, date }) => {
  expect(formatTemplateDate(new Date('2026-10-23T22:30:00Z'), zone)).toBe(date)
})

it.each([
  { zone: 'Asia/Shanghai', date: '2026-10-24', suffix: '10-24' },
  { zone: undefined, date: '2026-10-23', suffix: '10-23' },
])('dates remote openings and wake text in the node zone: $zone', async ({ zone, date, suffix }) => {
  const f = await admissionHost()
  try {
    if (zone) {
      f.ctx.loader.builtins.gates = Gates
      await f.load('template-gates.yml', [{ name: 'cordis:gates', config: { timeZone: zone } }])
    }
    expect(await f.seats.save({ definition: { ...f.definition,
      wakeTemplate: { kind: 'text', text: 'Wake {{seat}} on {{date}}.' } },
    expectedRevision: 2, operationId: operation('save-wake-template') })).toMatchObject({ status: 'saved' })
    const remote = f.ctx.get('seats')!.withAuthority({ ...f.authority, origin: 'remote' })
    const request = { seat: f.definition.seat, origin: 'remote' as const, operationId: operation('remote-template-date') }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T22:30:00Z'))
    const opened = await completesTurn(f.ctx, () => true, inputContains(`Open seat-a on ${date}`), () => remote.open(request))
    expect(opened).toMatchObject({ status: 'opened', title: `seat-a ${suffix}` })
    if (opened.status !== 'opened') throw new Error('Remote window did not open')
    const frozen = structuredClone(f.engine.journal.projection.opens.get(opened.sessionId)?.frozenOpening)
    expect(frozen).toMatchObject({ variables: { date }, text: `Open seat-a on ${date} for .` })
    const wake = await completesTurn(f.ctx, id => id === opened.sessionId, inputContains(`Wake seat-a on ${date}.`),
      () => remote.wake({ seat: f.definition.seat, operationId: operation('wake-template-date') }))
    expect(wake).toMatchObject({ status: 'sent', sessionId: opened.sessionId })
    const session = f.ctx.sessions.get(opened.sessionId)!
    const messages = session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(messages.flatMap(event => event.data.content).filter(part => part.type === 'text').map(part => part.text))
      .toContain(`Wake seat-a on ${date}.`)
    vi.setSystemTime(new Date('2026-10-25T22:30:00Z'))
    const restored = await f.reload()
    const replay = await restored.withAuthority({ ...f.authority, origin: 'remote' }).open(request)
    expect(replay).toMatchObject({ status: 'opened', sessionId: opened.sessionId, title: opened.title })
    expect(f.engine.journal.projection.opens.get(opened.sessionId)?.frozenOpening).toEqual(frozen)
  } finally {
    vi.useRealTimers()
    await f.close()
  }
}, 15000)
