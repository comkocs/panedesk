/** Private-session preparation shares the Agent creation rollback owner. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished } from 'vitest'
import AgentLoop from '../src/index.ts'

it.each(['failure', 'cancel', 'owner', 'factory'] as const)(
  'rolls back an unpublished session after preparation %s', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'session-preparation-'))
    const ctx = new Context()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(async () => {
      release.resolve(undefined)
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Persistence, { root })
    const loop = await ctx.plugin(AgentLoop, { agents: [] })
    let ownerCtx = ctx
    const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['agents'] }))
    const id = SessionId(`private-preparation-${outcome}`)
    const failure = new Error('private preparation rejected')
    const caller = new AbortController()
    const announced: string[] = []
    ctx.on('session/created', () => { announced.push('session') })
    ctx.on('agent/created', () => { announced.push('agent') })
    const remove = ctx.on('session/preparing', async (session, signal) => {
      expect(session.id).toBe(id)
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(ctx.agents.get(id)).toBeUndefined()
      entered.resolve(signal)
      await release.promise
      if (outcome === 'failure') throw failure
      signal.throwIfAborted()
    })
    const creating = ownerCtx.agents.create({ sessionId: id, signal: caller.signal })
    const rejected = expect(creating).rejects.toThrow(outcome === 'failure' ? failure : /disposed|not active|cancelled/)
    const signal = await entered.promise
    const aborted = Promise.withResolvers<undefined>()
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    let disposing: Promise<unknown> | undefined
    if (outcome === 'cancel') caller.abort(new Error('creation cancelled'))
    if (outcome === 'owner') disposing = owner.dispose()
    if (outcome === 'factory') disposing = loop.dispose()
    if (outcome !== 'failure') {
      await aborted.promise
      expect(signal.aborted).toBe(true)
    }
    release.resolve(undefined)
    await rejected
    await disposing
    expect(announced).toEqual([])
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.list()).toEqual([])
    expect(await readdir(root)).toEqual([])
    remove()
    if (outcome === 'failure' || outcome === 'cancel') {
      const recreated = await ctx.agents.create({ sessionId: id })
      await recreated.dispose()
    }
  },
)

it('prepares and stores private events before session and agent announcements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-preparation-store-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const order: string[] = []
  ctx.on('session/preparing', (session) => {
    order.push('prepare')
    session.append('approval/policy', { policy: 'never' })
  })
  ctx.on('session/created', (session) => {
    order.push('session')
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['approval/policy'])
  })
  ctx.on('agent/created', () => { order.push('agent') })
  const handle = await ctx.agents.create({ sessionId: SessionId('prepared-persistence') })
  await handle.dispose()
  const reader = await ctx.sessionPersistence.open(handle.agent.id, 'read')
  try {
    expect((await reader.read()).events.map(event => [event.type, event.data])).toEqual([
      ['approval/policy', { policy: 'never' }],
    ])
  } finally { await reader.close() }
  expect(order).toEqual(['prepare', 'session', 'agent'])
})
