/** Real child sessions retain durable seat metadata independently of their live handles. */
import assert from 'node:assert/strict'
import Subagents, { type SubagentActivation } from '@panedesk/dsh-subagent'
import * as Spawn from '@panedesk/dsh-subagent-spawn-in-process'
import { createUserMessage } from '@panedesk/dsh-llm'
import { admissionHost } from '../../seat-local/tests/admission-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { completesIdleTurn } from '../../seat/tests/completion.ts'
import { ChildAdmissionProvider } from '../src/child-admission.ts'

export async function childBindingHost(root?: string): Promise<Awaited<ReturnType<typeof admissionHost>>> {
  const f = await admissionHost(root)
  try {
    Object.assign(f.ctx.loader.builtins, { subagents: Subagents, spawn: Spawn })
    await f.load('binding-children.yml', [{ name: 'cordis:subagents' }, { name: 'cordis:spawn' }])
    await f.ctx.plugin({ name: 'binding-child-admission', async apply(ctx) {
      const admission = new ChildAdmissionProvider(ctx, f.engine)
      ctx.provide('subagentAdmission', admission)
      ctx.effect(() => () => admission.close())
      await admission.start()
    } })
    return f
  } catch (error) { await f.close(); throw error }
}

export async function createBoundChain(f: Awaited<ReturnType<typeof childBindingHost>>) {
  const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
    operationId: operation('binding-chain') })
  assert.equal(opened.status, 'prefilled')
  if (opened.status !== 'prefilled') throw new Error('Parent window was not created')
  const root = f.ctx.agents.get(opened.sessionId)!
  await completesIdleTurn(f.ctx, root, () => { root.followup(createUserMessage({
    content: [{ type: 'text', text: 'Initialize parent identity.' }], source: { kind: 'user' },
  })) })
  const binding = await f.ctx.get('seatLocalRead')!.binding({ sessionId: root.id })
  assert.ok(binding && !('status' in binding) && binding.kind === 'seat')
  const barrier = Promise.withResolvers<undefined>()
  const stream = f.adapter.stream.bind(f.adapter)
  f.adapter.stream = async function* (options) { await barrier.promise; yield* stream(options) }
  const children: SubagentActivation[] = []
  const ids = [root.id]
  let parent = root
  try {
    for (let depth = 1; depth <= 4; depth++) {
      const child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: `binding-${depth}`,
        request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: 'Retain inherited identity.' }] },
        signal: new AbortController().signal, delivery: 'caller' })
      children.push(child)
      const descendant = f.ctx.agents.get(child.childId)!
      assert.equal(descendant.session.header.parentSession, parent.id)
      const seatBinding = await f.ctx.get('seatLocalRead')!.binding({ sessionId: child.childId })
      assert.deepEqual(seatBinding, { ...binding, sessionId: child.childId, identitySource: 'inherited' })
      const rows = (await f.ctx.sessionLedger.query({ sessionId: child.childId })).rows.filter(row => row.kind === 'run')
      assert.ok(rows.length > 0)
      assert.ok(rows.every(row => row.start.identitySource === 'inherited' && row.start.seat === binding.seat))
      await f.ctx.sessions.flush(descendant.session)
      ids.push(child.childId)
      parent = descendant
    }
    return { ids, binding }
  } finally {
    barrier.resolve(undefined)
    f.adapter.stream = stream
    for (const child of children.reverse()) { await child.result; await child.dispose() }
  }
}
