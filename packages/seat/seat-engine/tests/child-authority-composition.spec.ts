/** Real local authority and child admission compose through the Loader. */
import { expect, it } from 'vitest'
import Subagents, { delegationDepthOf, type SubagentActivation } from '@panedesk/dsh-subagent'
import * as Spawn from '@panedesk/dsh-subagent-spawn-in-process'
import { admissionHost } from '../../seat-local/tests/admission-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { ChildAdmissionProvider } from '../src/child-admission.ts'

it('preserves eight real parent links under trusted reads and rejects the ninth child before creation', async () => {
  const f = await admissionHost()
  const children: SubagentActivation[] = []
  const barrier = Promise.withResolvers<undefined>()
  const stream = f.adapter.stream.bind(f.adapter)
  let held = false
  f.adapter.stream = async function* (options) {
    if (held) await barrier.promise
    yield* stream(options)
  }
  try {
    Object.assign(f.ctx.loader.builtins, { subagents: Subagents, spawn: Spawn })
    await f.load('children.yml', [{ name: 'cordis:subagents' }, { name: 'cordis:spawn' }])
    await f.ctx.plugin({ name: 'child-admission-owner', async apply(ctx) {
      const admission = new ChildAdmissionProvider(ctx, f.engine)
      ctx.provide('subagentAdmission', admission)
      ctx.effect(() => () => admission.close())
      await admission.start()
    } })
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () =>
      f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('open-chain') }))
    if (opened.status !== 'opened') throw new Error('Parent window was not opened')
    let parent = f.ctx.agents.get(opened.sessionId)!
    await parent.whenIdle()
    held = true
    for (let depth = 1; depth <= 8; depth++) {
      const child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: `level-${depth}`,
        request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: 'Nested task.' }] },
        signal: new AbortController().signal, delivery: 'caller' })
      children.push(child)
      const descendant = f.ctx.agents.get(child.childId)!
      expect(descendant.session.header.parentSession).toBe(parent.id)
      expect(delegationDepthOf(descendant)).toBe(depth)
      parent = descendant
    }
    const before = (await f.ctx.sessionPersistence.list()).length
    await expect(f.ctx.subagents.startActivation({ provider: 'spawn', label: 'level-9',
      request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: 'Must not start.' }] },
      signal: new AbortController().signal, delivery: 'caller' })).rejects.toMatchObject({
      name: 'SubagentDepthError', attemptedDepth: 9, maxDepth: 8,
      message: 'subagent depth 9 exceeds maxDepth 8',
    })
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(before)
    expect(f.ctx.agents.list()).toHaveLength(9)
  } finally {
    barrier.resolve(undefined)
    for (const child of children.reverse()) { await child.result; await child.dispose() }
    await f.close()
  }
}, 30000)

it('keeps external binding calls unauthorized before and after trusted local reads', async () => {
  const f = await admissionHost()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('open-binding') })
    if (opened.status !== 'prefilled') throw new Error('Parent window was not created')
    const request = { sessionId: opened.sessionId }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.ctx.get('seats')!.binding(request)).rejects.toMatchObject({
        message: 'Verified authority is required.', failure: { code: 'unauthorized' },
      })
      expect(await f.ctx.get('seatLocalRead')!.binding(request)).toMatchObject({
        kind: 'seat', seat: f.definition.seat, sessionId: opened.sessionId,
      })
    }
  } finally { await f.close() }
})
