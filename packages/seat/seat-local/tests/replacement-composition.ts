/** Real replacement admission consumes original first-turn evidence before releasing the old window. */
import { expect, vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import Jobs from '@panedesk/dsh-jobs-local'
import Questions from '@panedesk/dsh-user-questions'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { localFact } from '../src/engine-state.ts'

/** Exercise both capacity and archive using the production internal authority registration.
 * @param f - real engine, local service, AgentLoop and persistence.
 * @param oldSessionId - original completed opening.
 */
export async function checkReplacement(f: Awaited<ReturnType<typeof engineFixture>>, oldSessionId: SessionId): Promise<void> {
  const raw = f.ctx.get('seats')
  if (!raw) throw new Error('Local seat service is unavailable')
  const seats = raw.withAuthority({ principalId: 'user-a' as T.SeatPrincipalId, origin: 'manual', nodeId: f.options.nodeId })
  Object.assign(f.ctx.loader.builtins, { jobs: Jobs, questions: Questions })
  const path = join(f.options.directory, 'replacement.yml')
  await writeFile(path, JSON.stringify([{ name: 'cordis:jobs', config: {} }, { name: 'cordis:questions', config: {} }]))
  await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await f.ctx.loader.await()
  await expect(raw.list({})).rejects.toMatchObject({ failure: { code: 'unauthorized' } })
  await expect(raw.close({ sessionId: oldSessionId, operationId: operation('external-close'), expectedStateVersion: 1 }))
    .rejects.toMatchObject({ failure: { code: 'unauthorized' } })
  let oldBusy = true
  const releaseBusy = f.ctx.on('workspace/session-activity', async (request, next) => {
    const upstream = await next()
    return request.sessionId === oldSessionId && oldBusy
      ? [...upstream, { kind: 'subagent' as const, items: [{ id: 'pending-child' }] }] : upstream
  })
  const saveLimit = async (maxOpenSessions: number) => {
    const catalog = await seats.definitions({})
    f.definition.maxOpenSessions = maxOpenSessions
    expect(await seats.save({ definition: f.definition, expectedRevision: catalog.revision,
      operationId: operation(`limit-${maxOpenSessions}`) })).toMatchObject({ status: 'saved' })
  }
  try {
    await saveLimit(1)
    const request = { sessionId: oldSessionId, operationId: operation('replace-real') }
    expect(await seats.replace(request)).toMatchObject({ status: 'queued' })
    await f.engine.drive()
    expect(f.engine.journal.projection.resources.size).toBe(1)
    expect([...f.engine.journal.projection.replacements.values()][0]?.newSessionId).toBeNull()
    expect([...f.engine.journal.projection.pending.values()]).toMatchObject([{ reason: 'seat-capacity' }])
    await saveLimit(2)
    await f.engine.drive()
    const next = [...f.engine.journal.projection.replacements.values()][0]?.newSessionId
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
    await f.engine.drive()
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
    if (!settled) throw new Error('Replacement terminal is missing')
    await f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/replacement', data: settled })] }))
    await expect(f.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'window/replacement',
      data: { ...settled, cleanup: 'pending' } })] }))).rejects.toMatchObject({ code: 'state-conflict' })
    expect(f.engine.journal.projection.replacements.get(settled.replacementId)).toEqual(settled)
    await f.engine.drive()
    const catalog = await seats.definitions({})
    expect(await seats.save({ definition: { ...f.definition, autoKeepAlive: true }, expectedRevision: catalog.revision,
      operationId: operation('enable-keepalive') })).toMatchObject({ status: 'saved' })
    const maintenance = f.dependencies.keepalive
    if (!maintenance) throw new Error('Maintenance transport is unavailable')
    const evidenceAt = Date.now()
    maintenance.remaining = async () => ({ kind: 'estimated', evidenceAt, ttlSeconds: 3600, seconds: 3600 })
    await f.engine.drive()
    const before = f.renewals.length
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(evidenceAt + 3360000))
    await f.engine.drive()
    await f.engine.drive()
    expect(f.renewals).toHaveLength(before + 1)
    expect(f.engine.journal.projection.keepalive.get(next)).toMatchObject({ source: 'auto', phase: 'renewed' })
  } finally { vi.useRealTimers(); releaseBusy() }
}
