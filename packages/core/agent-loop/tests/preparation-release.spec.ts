/** Temporary ledger attribution is released after takeover and cannot reappear on resume. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { mountAgentLoopTestDependencies } from '@panedesk/dsh-agent-loop-testkit'
import { createUserMessage } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import type { LedgerSessionContext } from '@panedesk/dsh-session-ledger'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MemoryLedger } from '../../../subagent/subagent/tests/ledger-fixture.ts'

class OwnedLedger extends MemoryLedger {
  readonly owners = new Map<symbol, LedgerSessionContext>()
  override bindContext(context: LedgerSessionContext): () => void {
    const owner = Symbol()
    this.owners.set(owner, context)
    return () => { this.owners.delete(owner) }
  }
  override contextFor(sessionId: SessionId): LedgerSessionContext | undefined {
    return [...this.owners.values()].filter(context => context.sessionId === sessionId).at(-1)
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'preparation-release-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(OwnedLedger)
  await ctx.plugin(Persistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const ledger = ctx.sessionLedger as OwnedLedger
  const sessionId = SessionId('window-a')
  const context: LedgerSessionContext = { sessionId, rootSessionId: sessionId,
    runId: 'reserved-run' as LedgerSessionContext['runId'], nodeId: await ledger.nodeId(),
    seat: 'seat-a', window: 'window-a', identitySource: 'startup', accountLabel: 'unknown' }
  const releasePreparation = ledger.bindContext(context)
  return { ctx, ledger, sessionId, releasePreparation,
    dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

describe('ledger preparation release', () => {
  it('releases the independent prebinding before publication and resumes with a fresh run identity', async () => {
    const f = await fixture()
    try {
      f.ctx.on('agent/created', () => { expect(f.ledger.owners.size).toBe(1) })
      const handle = await f.ctx.agents.create({ sessionId: f.sessionId, releasePreparation: f.releasePreparation })
      expect(f.ledger.starts[0]?.runId).toBe('reserved-run')
      handle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'queued work' }], source: { kind: 'user' } }), 'next-turn', false)
      await handle.dispose()
      expect(f.ledger.owners.size).toBe(0)
      expect(f.ledger.contextFor(f.sessionId)).toBeUndefined()
      const resumed = await f.ctx.agents.resume({ resumeSessionId: f.sessionId })
      expect(f.ledger.starts).toHaveLength(2)
      expect(f.ledger.starts[1]?.runId).not.toBe('reserved-run')
      await resumed.dispose()
      expect(f.ledger.owners.size).toBe(0)
    } finally { await f.dispose() }
  })

  it.each(['admission', 'setup', 'commit', 'ledger', 'announcement'] as const)('leaves no prebinding after %s failure', async (phase) => {
    const f = await fixture()
    try {
      if (phase === 'admission') f.ctx.on('agent/create-admitting', async () => ({ kind: 'reject', reason: 'denied' }))
      if (phase === 'ledger') f.ledger.failStart = true
      if (phase === 'announcement') f.ctx.on('agent/created', () => { throw new Error('announcement failed') })
      await expect(f.ctx.agents.create({ sessionId: f.sessionId, releasePreparation: f.releasePreparation,
        setup: () => {
          if (phase === 'setup') throw new Error('setup failed')
          return { commit: () => { if (phase === 'commit') throw new Error('commit failed') } }
        },
      })).rejects.toThrow()
      expect(f.ledger.owners.size).toBe(0)
      expect(f.ledger.contextFor(f.sessionId)).toBeUndefined()
      expect(f.ctx.agents.get(f.sessionId)).toBeUndefined()
    } finally { await f.dispose() }
  })
})
