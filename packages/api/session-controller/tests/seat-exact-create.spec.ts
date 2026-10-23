/** The public trusted entry never substitutes identities or persists global model defaults. */
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { createUserMessage } from '@panedesk/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { describe, expect, it, vi } from 'vitest'
import { SessionCreationScope, ApiSessionExactCreateConflict } from '../src/index.ts'
import { createSessionTestController } from './test-remote.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'exact-create-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const saveDefault = vi.fn()
  createSessionTestController(ctx, { cwd: root,
    defaultModelSelection: () => ({ provider: 'mock', model: 'model-a' }),
    saveDefaultModelSelection: saveDefault,
  })
  return { ctx, root, saveDefault, dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

describe('public exact creation', () => {
  it('publishes the reserved identity with local model selection before observers and never saves the default', async () => {
    const f = await fixture()
    try {
      expect(f.ctx.sessionCreation).toBeInstanceOf(SessionCreationScope)
      const releasePreparation = vi.fn()
      const setup = vi.fn()
      f.ctx.on('agent/created', ({ agent }) => {
        expect(setup).toHaveBeenCalledOnce()
        expect(releasePreparation).toHaveBeenCalled()
        expect(agent.session.snapshotEvents().find(event => event.type === 'model/selection')?.data)
          .toEqual({ provider: 'mock', model: 'model-b' })
      })
      const result = await f.ctx.sessionCreation.create({ sessionId: SessionId('window-a'), cwd: f.root,
        selection: { provider: 'mock', model: 'model-b' }, setup, releasePreparation })
      expect(result.agent.id).toBe('window-a')
      expect(f.saveDefault).not.toHaveBeenCalled()
      expect(f.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'mock', model: 'model-a' })
      await expect(f.ctx.sessionCreation.create({ sessionId: result.agent.id, cwd: f.root }))
        .rejects.toBeInstanceOf(ApiSessionExactCreateConflict)
      expect(f.ctx.agents.list()).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('rejects before directory, setup and publication and releases failed preparation', async () => {
    const f = await fixture()
    try {
      const cwd = join(f.root, 'not-created')
      const setup = vi.fn()
      const releasePreparation = vi.fn()
      f.ctx.on('agent/create-admitting', async () => ({ kind: 'reject', reason: 'choice-required' }))
      await expect(f.ctx.sessionCreation.create({ sessionId: SessionId('window-a'), cwd, setup, releasePreparation }))
        .rejects.toMatchObject({ reason: 'choice-required' })
      expect(setup).not.toHaveBeenCalled()
      expect(f.ctx.sessions.get(SessionId('window-a'))).toBeUndefined()
      await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(releasePreparation).toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('composes controlled creation with policy denial, turn deferral and explicit wake without default changes', async () => {
    const f = await fixture()
    try {
      const adapter = new MockAdapter([textResponse('accepted')])
      f.ctx.llm.registerAdapter(['mock'], adapter)
      let admitted = false
      let deferred = true
      const preparation = new Set<symbol>()
      const reserve = () => {
        const owner = Symbol()
        preparation.add(owner)
        return () => { preparation.delete(owner) }
      }
      f.ctx.on('agent/create-admitting', async (_payload, next) => admitted ? next() : { kind: 'reject', reason: 'choice-required' })
      f.ctx.on('agent/turn-admitting', (_payload, next) => deferred ? { kind: 'defer', reason: 'budget' } : next())
      const sessionId = SessionId('window-a')
      await expect(f.ctx.sessionCreation.create({ sessionId, cwd: f.root, releasePreparation: reserve() }))
        .rejects.toMatchObject({ reason: 'choice-required' })
      expect(preparation.size).toBe(0)
      expect(f.ctx.agents.get(sessionId)).toBeUndefined()
      admitted = true
      f.ctx.on('agent/created', () => { expect(preparation.size).toBe(0) })
      const { agent } = await f.ctx.sessionCreation.create({ sessionId, cwd: f.root,
        selection: { provider: 'mock', model: 'model-b' }, releasePreparation: reserve(),
        setup: (_ctx, created) => {
          created.followup(createUserMessage({ content: [{ type: 'text', text: 'queued work' }], source: { kind: 'user' } }))
        },
      })
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(0)
      deferred = false
      agent.wake?.()
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.model).toBe('model-b')
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(f.saveDefault).not.toHaveBeenCalled()
      expect(f.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'mock', model: 'model-a' })
      expect(preparation.size).toBe(0)
    } finally { await f.dispose() }
  })

  it('releases temporary ownership on setup and identity-conflict failures', async () => {
    const f = await fixture()
    try {
      const releasePreparation = vi.fn()
      const failure = new Error('setup failed')
      await expect(f.ctx.sessionCreation.create({ sessionId: SessionId('window-a'), cwd: f.root,
        setup: () => { throw failure }, releasePreparation })).rejects.toBe(failure)
      expect(releasePreparation).toHaveBeenCalled()
      expect(f.ctx.agents.get(SessionId('window-a'))).toBeUndefined()
      const created = await f.ctx.sessionCreation.create({ sessionId: SessionId('window-b'), cwd: f.root })
      const conflictRelease = vi.fn()
      await expect(f.ctx.sessionCreation.create({ sessionId: created.agent.id, cwd: f.root, releasePreparation: conflictRelease }))
        .rejects.toBeInstanceOf(ApiSessionExactCreateConflict)
      expect(conflictRelease).toHaveBeenCalled()
    } finally { await f.dispose() }
  })
})
