/** Real replacement admission consumes original first-turn evidence before releasing the old window. */
import { expect } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import type { engineFixture } from './engine-fixture.ts'
import { LocalCloser } from '../src/closing-service.ts'
import { operation } from './fixtures.ts'

/** Exercise double capacity and the real archive path with explicit test-only engine authority.
 * @param f - real engine, local service, AgentLoop and persistence.
 * @param oldSessionId - original completed opening.
 */
export async function checkReplacement(f: Awaited<ReturnType<typeof engineFixture>>, oldSessionId: SessionId): Promise<void> {
  const raw = f.ctx.get('seats')
  if (!raw) throw new Error('Local seat service is unavailable')
  const seats = raw.withAuthority({ principalId: 'test-engine' as T.SeatPrincipalId, origin: 'engine', nodeId: f.options.nodeId })
  const original = f.dependencies.seats.bind(f.dependencies)
  const closer = new LocalCloser(f.ctx, f.state, f.runtime, f.options)
  let oldBusy = true
  f.dependencies.seats = () => ({ resolve: async () => f.definition, list: async () => {
    const opens = [...f.engine.journal.projection.opens.values()].filter(open => f.engine.journal.projection.resources.has(open.sessionId))
    return { status: 'listed', complete: true, snapshotAt: new Date().toISOString(), unopenedSeats: [], sessions: opens.map(open => ({
      seat: f.definition.seat, sessionId: open.sessionId, nodeId: f.options.nodeId, title: open.title ?? f.definition.seat,
      status: 'idle', busyReasons: oldBusy && open.sessionId === oldSessionId ? [{ kind: 'turn', summary: 'Original work is pending.' }] : [], idleMinutes: 0, runningSubagents: 0, activeJobs: 0, canRenew: false,
      renewRejection: null, stateVersion: 1, engineStatus: 'active', evidence: 'complete', seatBinding: open.binding,
    })) }
  }, close: request => closer.close(request) })
  try {
    f.definition.maxOpenSessions = 1
    const request = { sessionId: oldSessionId, operationId: operation('replace-real') }
    expect(await seats.replace(request)).toMatchObject({ status: 'queued' })
    await f.engine.drive()
    expect(f.engine.journal.projection.resources.size).toBe(1)
    const pending = [...f.engine.journal.projection.replacements.values()][0]
    expect(pending?.newSessionId).toBeNull()
    expect([...f.engine.journal.projection.pending.values()]).toMatchObject([{ reason: 'seat-capacity' }])
    f.definition.maxOpenSessions = 2
    await f.engine.drive()
    const replacing = [...f.engine.journal.projection.replacements.values()][0]
    const next = replacing?.newSessionId
    if (!next) throw new Error('Replacement Session was not reserved')
    expect(next).not.toBe(oldSessionId)
    expect(f.engine.journal.projection.resources.size).toBe(2)
    await expect.poll(() => f.ctx.agents.get(next)?.session.snapshotEvents().some(event => event.type === 'turn/end'
      && event.data.reason.kind === 'completed')).toBe(true)
    await f.ctx.agents.get(oldSessionId)?.whenIdle()
    await f.ctx.agents.get(next)?.whenIdle()
    await f.engine.drive()
    expect([...f.engine.journal.projection.replacements.values()][0]?.phase).toBe('awaiting-old-idle')
    expect(f.engine.journal.projection.resources.get(oldSessionId)?.exclusiveTags).toEqual(['resource-a'])
    expect(f.engine.journal.projection.resources.get(next)?.exclusiveTags).toEqual([])
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(oldSessionId)
    oldBusy = false
    // The upstream driver currently republishes a different terminal object after local recordClosed.
    await expect(f.engine.drive()).rejects.toThrow('Terminal close already exists')
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(oldSessionId)
    await f.engine.drive()
    const settled = [...f.engine.journal.projection.replacements.values()][0]
    expect(settled).toMatchObject({ phase: 'completed', oldSessionId, newSessionId: next,
      firstTurn: { completed: true, hasAssistantReply: true } })
    expect(f.engine.journal.projection.resources.size).toBe(1)
    expect(f.engine.journal.projection.resources.has(next)).toBe(true)
    expect(f.engine.journal.projection.resources.has(oldSessionId)).toBe(false)
    await seats.replace(request)
    expect(f.engine.journal.projection.opens.size).toBe(2)
  } finally { f.dependencies.seats = original; await closer.drain() }
}
