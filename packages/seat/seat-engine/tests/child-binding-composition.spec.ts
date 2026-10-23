/** Persisted child bindings preserve inherited identities without changing free directory admission. */
import { expect, it } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import { childBindingHost, createBoundChain } from './child-binding-fixture.ts'

it('projects inherited seat bindings at every level of a four-child real parent chain', async () => {
  const f = await childBindingHost()
  try {
    const { ids, binding } = await createBoundChain(f)
    expect(ids).toHaveLength(5)
    for (const sessionId of ids.slice(1)) {
      const seatBinding = await f.ctx.get('seatLocalRead')!.binding({ sessionId })
      expect(seatBinding).toEqual({ ...binding, sessionId, identitySource: 'inherited' })
      const fact = (await f.state.read()).effects.findLast(effect => effect.kind === 'seat/binding'
        && effect.data.sessionId === sessionId)
      expect(fact?.data).toEqual(seatBinding)
    }
  } finally { await f.close() }
}, 30000)

it('keeps children of a traditional free window free and still requires an owned directory choice', async () => {
  const f = await childBindingHost()
  try {
    const creation = f.ctx.get('seatLocalCreation')!
    const confirmation = await creation.confirmTraditional(f.options.directory, f.authority)
    const handle = await creation.run(confirmation, f.authority, () => f.ctx.agents.create({
      sessionId: 'free-parent' as SessionId, meta: { cwd: f.options.directory },
    }))
    try {
      expect(await f.ctx.get('seatLocalRead')!.binding({ sessionId: handle.agent.id })).toMatchObject({
        kind: 'free', identitySource: 'free',
      })
      const activate = () => f.ctx.subagents.startActivation({ provider: 'spawn', label: 'free-child',
        request: { parent: handle.agent, prompt: [{ type: 'text', text: 'Keep the traditional identity.' }] },
        signal: new AbortController().signal, delivery: 'caller' })
      await expect(activate()).rejects.toMatchObject({ name: 'SeatDirectoryChoiceError', result: {
        status: 'choice-required', candidates: ['seat-a'],
      } })
      const childChoice = await creation.confirmTraditional(f.options.directory, f.authority)
      const child = await creation.run(childChoice, f.authority, activate)
      try {
        await child.result
        expect(await f.ctx.get('seatLocalRead')!.binding({ sessionId: child.childId })).toMatchObject({
          kind: 'free', identitySource: 'free',
        })
        const rows = (await f.ctx.sessionLedger.query({ sessionId: child.childId })).rows.filter(row => row.kind === 'run')
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every(row => row.start.seat === 'free')).toBe(true)
      } finally { await child.dispose() }
    } finally { await handle.dispose() }
  } finally { await f.close() }
}, 30000)
