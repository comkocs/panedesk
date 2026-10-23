import { describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { brandString } from '@panedesk/dsh-brand'
import { SessionId } from '@panedesk/dsh-session'
import SubagentRuntime, { SubagentQueuedError } from '../src/index.ts'
import type { SubagentActivation, SubagentActivationSpec, SubagentAdmission, SubagentNotifications, SubagentQueued, SubagentResult } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { subagentManager } from './manager-internals.ts'

async function setup() {
  const ctx = new Context()
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const parent = await externalTestParent(ctx)
  const results: PromiseWithResolvers<SubagentResult>[] = []
  ctx.subagents.registerProvider({
    name: 'external', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => {
      const result = Promise.withResolvers<SubagentResult>()
      results.push(result)
      return { id: SessionId(`child-${results.length}`), result: result.promise,
        dispose: async () => { result.resolve({ output: [], stopReason: 'aborted' }) } }
    },
  })
  const spec = (label: string): SubagentActivationSpec => ({
    provider: 'external', label, signal: new AbortController().signal, delivery: 'caller',
    request: { parent, prompt: [{ type: 'text', text: label }] },
  })
  return { ctx, parent, results, spec }
}

const completed: SubagentResult = { output: [{ type: 'text', text: 'Finished' }], stopReason: 'completed' }

describe('optional subagent admission and settlement', () => {
  it('queues the fifth child immediately and delegates FIFO release before later starts', async () => {
    const { ctx, parent, results, spec } = await setup()
    let reserved = 0
    const queue: SubagentActivationSpec[] = []
    const selected: string[] = []
    const replayed: SubagentActivation[] = []
    const granted = new Set<SubagentActivationSpec>()
    const policy: SubagentAdmission = {
      acquire: async (request) => {
        if (!granted.delete(request) && (reserved === 4 || queue.length > 0)) {
          queue.push(request)
          return { status: 'queued', ticketId: brandString<SubagentQueued['ticketId']>(`ticket-${queue.length}`), parentSessionId: parent.id }
        }
        reserved++
        return { status: 'reserved', release: async () => {
          reserved--
          const next = queue.shift()
          if (next !== undefined) {
            selected.push(next.label)
            granted.add(next)
            replayed.push(await ctx.subagents.startActivation(next))
          }
        } }
      },
      continue: async () => {},
      resume: async () => { throw new Error('not used') },
    }
    ctx.provide('subagentAdmission', policy)
    const active: SubagentActivation[] = []
    for (let index = 0; index < 4; index++) active.push(await ctx.subagents.startActivation(spec(`work-${index}`)))
    expect(await ctx.subagents.requestActivation(spec('fifth'))).toEqual({
      status: 'queued', ticketId: 'ticket-1', parentSessionId: parent.id,
    })
    await expect(subagentManager(ctx).startExternal(spec('sixth'))).rejects.toBeInstanceOf(SubagentQueuedError)
    expect(results).toHaveLength(4)
    results[0]!.resolve(completed)
    await active[0]!.result
    results[1]!.resolve(completed)
    await active[1]!.result
    expect(selected).toEqual(['fifth', 'sixth'])
    expect(results).toHaveLength(6)
    expect(replayed.map(item => item.childId)).toEqual(['child-5', 'child-6'])
    expect(reserved).toBe(4)
    await Promise.all([...active.slice(2), ...replayed].map(item => item.dispose()))
    await Promise.all([...active.slice(2), ...replayed].map(item => item.result))
    expect(reserved).toBe(0)
  })

  it.each(['subagent-renewal-expired', 'subagent-context-limit', 'evidence-unavailable'])(
    'rejects direct manager continuation with %s before delivery and permits new work', async (code) => {
      const { ctx, parent, spec } = await setup()
      const policy: SubagentAdmission = {
        acquire: async () => ({ status: 'reserved', release: async () => {} }),
        continue: async () => { throw new Error(`${code}: start a new subagent`) },
        resume: async () => { throw new Error('must not resume') },
      }
      ctx.provide('subagentAdmission', policy)
      await expect(subagentManager(ctx).sendMessage(parent, SessionId('settled-child'), [], {
        signal: new AbortController().signal,
      })).rejects.toThrow(`${code}: start a new subagent`)
      expect(parent.inbox.nextTurn).toEqual([])
      const activation = await ctx.subagents.startActivation(spec('fresh'))
      await activation.dispose()
    },
  )

  it.each([
    { idleMs: 60_001, ttlMs: 60_000, tokens: 399_999, code: 'subagent-renewal-expired' },
    { idleMs: 60_000, ttlMs: 60_000, tokens: 400_000, code: 'subagent-context-limit' },
    { idleMs: 0, ttlMs: 60_000, tokens: 400_001, code: 'subagent-context-limit' },
    { idleMs: 0, ttlMs: undefined, tokens: 1, code: 'evidence-unavailable' },
  ])('checks child evidence at idle=$idleMs tokens=$tokens through the actual manager', async (evidence) => {
    const { ctx, parent, spec } = await setup()
    const childId = SessionId('settled-child')
    const checked: SessionId[] = []
    // Policy belongs to the optional provider; the manager must enforce its refusal.
    ctx.provide('subagentAdmission', {
      acquire: async () => ({ status: 'reserved', release: async () => {} }),
      continue: async (owner, id) => {
        expect(owner).toBe(parent)
        checked.push(id)
        if (evidence.ttlMs === undefined) throw new Error('evidence-unavailable: start a new subagent')
        if (evidence.idleMs > evidence.ttlMs) throw new Error('subagent-renewal-expired: start a new subagent')
        if (evidence.tokens >= 400_000) throw new Error('subagent-context-limit: start a new subagent')
      },
      resume: async () => { throw new Error('refused work must not resume') },
    } satisfies SubagentAdmission)
    const manager = subagentManager(ctx)
    await expect(manager.queuePrompt(parent, childId, [{ type: 'text', text: 'continue' }], { kind: 'user' },
      new AbortController().signal)).rejects.toThrow(`${evidence.code}: start a new subagent`)
    await expect(manager.steerPrompt(parent, childId, [], { kind: 'user' },
      new AbortController().signal)).rejects.toThrow(evidence.code)
    expect(checked).toEqual([childId, childId])
    expect(parent.inbox.nextTurn).toEqual([])
    expect(parent.inbox.nextStep).toEqual([])
    const fresh = await ctx.subagents.startActivation(spec('fresh'))
    await fresh.dispose()
  })

  it('delegates exactly one waking settlement with event kind and child id within five seconds', async () => {
    const { ctx, parent, results, spec } = await setup()
    const accept = vi.fn<SubagentNotifications['accept']>(async ({ parent, message }) => { parent.steer(message) })
    ctx.provide('subagentNotifications', { accept })
    const activation = await ctx.subagents.startActivation({ ...spec('return'), delivery: 'parent' })
    const observedAt = performance.now()
    results[0]!.resolve(completed)
    await activation.result
    expect(performance.now() - observedAt).toBeLessThanOrEqual(5000)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0]![0]).toMatchObject({
      childId: activation.childId, eventKind: 'subagent', messageClass: 'handoff', delivery: 'steer', result: completed,
    })
    expect(parent.inbox.nextStep).toHaveLength(1)
    expect(parent.inbox.nextTurn).toHaveLength(0)
  })

  it('rejects uncertain durable notification without falling back to a duplicate followup', async () => {
    const { ctx, parent, results, spec } = await setup()
    ctx.provide('subagentNotifications', { accept: async () => { throw new Error('notification write failed') } })
    const activation = await ctx.subagents.startActivation({ ...spec('return'), delivery: 'parent' })
    results[0]!.resolve(completed)
    await expect(activation.result).rejects.toThrow('notification write failed')
    expect(parent.inbox.nextStep).toEqual([])
    expect(parent.inbox.nextTurn).toEqual([])
  })
})
