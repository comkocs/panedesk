/** Closing an approval-paused tool turn uses the product cancellation lifecycle. */
import { expect, it } from 'vitest'
import { createUserMessage } from '@panedesk/dsh-llm'
import { approvalHost } from './approval-fixture.ts'
import { operation } from './fixtures.ts'
import { createEngineAccess } from '../src/engine-access.ts'

it.each(['close', 'stale', 'inbox'] as const)('handles a real pending tool approval: %s', async (scenario) => {
  const f = await approvalHost()
  try {
    const { agent } = f
    if (scenario === 'inbox') agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep this queued input.' }], source: { kind: 'user' } }))
    await f.ctx.sessions.flush(agent.session)
    const listed = await f.seats.list({})
    if (listed.status !== 'listed') throw new Error('Windows unavailable')
    const window = listed.sessions.find(item => item.sessionId === agent.id)!
    expect(window.status).toBe('approval-pending')
    const access = createEngineAccess(f.ctx.get('seats')!, f.options)
    const result = await access.close({ sessionId: agent.id, expectedStateVersion: window.stateVersion - (scenario === 'stale' ? 1 : 0), operationId: operation('approval-close') })
    if (scenario === 'stale') {
      expect(result.status).toBe('conflict')
      expect(agent.status).toBe('running')
      expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(agent.id)
      return
    }
    if (scenario === 'inbox') {
      expect(result).toMatchObject({ status: 'busy', busyReasons: [expect.objectContaining({ kind: 'inbox' })] })
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(agent.status).toBe('idle')
      expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(agent.id)
      return
    }
    expect(result.status).toBe('closed')
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(agent.id)
    await f.ctx.sessions.flush(agent.session)
    const snapshot = await f.ctx.sessionQuery.readSession(agent.id)
    expect(snapshot.events.find(event => event.type === 'approval/decided')).toMatchObject({ data: { outcome: 'cancelled' } })
    const effects = (await f.state.read()).effects
    expect(effects.find(effect => effect.kind === 'window/closed')).toMatchObject({ data: { reason: 'manual', detail: 'approval-pending-cancelled' } })
    const callbacks = effects.filter(effect => effect.kind === 'callback/pending' && effect.data.payload.kind === 'window-ended')
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toMatchObject({ data: { payload: { reason: 'manual', detail: 'approval-pending-cancelled' } } })
    const decision = snapshot.events.find(event => event.type === 'approval/decided')
    const closed = effects.find(effect => effect.kind === 'window/closed')
    expect({ approval: decision?.data.outcome, reason: closed?.data.reason, detail: closed?.data.detail,
      archived: f.ctx.workspaceRegistry.archivedSessionIds.includes(agent.id) }).toMatchInlineSnapshot(`
      {
        "approval": "cancelled",
        "archived": true,
        "detail": "approval-pending-cancelled",
        "reason": "manual",
      }
    `)
  } finally { await f.close() }
}, 30000)
