/** Replacement capacity uses real Loader, local service, journal and persisted first turns. */
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk } from '@panedesk/dsh-llm'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from '../../seat-local/tests/admission-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { commitsEffect, completesIdleTurn, completesTurn, inputContains } from '../../seat/tests/completion.ts'

it('continues a handover after host restart using the persisted opening turn', async () => {
  const home = await mkdtemp(join(tmpdir(), '.replacement-'))
  let host: Awaited<ReturnType<typeof admissionHost>> | undefined
  try {
    const f = await admissionHost(home); host = f
    const old = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('old') })
    if (old.status !== 'prefilled') throw new Error('Old window did not open')
    f.ctx.on('workspace/session-activity', async (request, next) => request.sessionId === old.sessionId
      ? [...await next(), { kind: 'subagent' as const, items: [{ id: 'pending-child' }] }] : next())
    await f.seats.replace({ sessionId: old.sessionId, operationId: operation('replace') })
    await completesTurn(f.ctx, id => id !== old.sessionId, inputContains('Open seat-a'), () => f.engine.drive())
    const before = [...f.engine.journal.projection.replacements.values()][0]
    if (!before?.newSessionId) throw new Error('Replacement did not open')
    const next = before.newSessionId, agent = f.ctx.agents.get(next)!
    await agent.whenIdle(); expect(await f.ctx.sessions.flush(agent.session)).toBe(true)
    await f.engine.drive()
    expect(f.engine.journal.projection.replacements.get(before.replacementId)).toMatchObject({
      phase: 'awaiting-old-idle', permit: { state: 'expired-success' } })
    await f.close(); host = undefined
    const restored = await admissionHost(home); host = restored
    const handles = []
    try {
      for (const resumeSessionId of [old.sessionId, next]) handles.push(await restored.ctx.agents.resume({
        resumeSessionId, agentOptions: { provider: 'provider-a', model: 'model-a' } }))
      await commitsEffect(restored.ctx, effect => effect.kind === 'window/replacement' && effect.data.phase === 'completed',
        () => restored.engine.drive())
      expect(restored.engine.journal.projection.replacements.get(before.replacementId)).toMatchObject({
        newSessionId: next, phase: 'completed', permit: { state: 'expired-success' } })
      expect(restored.engine.journal.projection.opens.size).toBe(2)
      expect(restored.ctx.workspaceRegistry.archivedSessionIds).toContain(old.sessionId)
      expect(restored.adapter.requests).toEqual([])
    } finally { for (const handle of handles) await handle.dispose() }
  } finally { await host?.close(); await rm(home, { recursive: true, force: true }) }
})

it.each([false, true])('replaces a full single-window seat with a real first turn, failed=%s', async (failed) => {
  const f = await admissionHost()
  const release = Promise.withResolvers<undefined>()
  try {
    const definition = { ...f.definition, maxOpenSessions: 1, rules: [{ id: 'rule-a' as T.SeatRuleId,
      enabled: true, trigger: { kind: 'manual' as const, origin: 'manual' as const }, timeWindows: [], exclusiveTags: ['resource-a'] }] }
    expect(await f.seats.save({ definition, expectedRevision: 2, operationId: operation('single-window') }))
      .toMatchObject({ status: 'saved' })
    const old = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () =>
      f.seats.open({ seat: definition.seat, origin: 'manual', operationId: operation('old') }))
    if (old.status !== 'opened') throw new Error('Old window did not open')
    await f.ctx.agents.get(old.sessionId)!.whenIdle()
    await f.engine.drive()
    const entered = Promise.withResolvers<undefined>()
    const stream = f.adapter.stream.bind(f.adapter)
    f.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
      entered.resolve(undefined)
      await release.promise
      if (failed) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'provider-error', message: 'Opening rejected by provider' } } }
      else yield* stream(options)
    }
    expect(await f.seats.replace({ sessionId: old.sessionId, operationId: operation('replace') }))
      .toMatchObject({ status: 'queued' })
    await f.engine.drive(); await entered.promise
    const transaction = [...f.engine.journal.projection.replacements.values()][0]
    const next = transaction?.newSessionId
    if (!next) throw new Error('Replacement window did not open')
    expect(next).not.toBe(old.sessionId)
    expect(f.engine.journal.projection.resources.size).toBe(2)
    expect(f.engine.journal.projection.resources.get(old.sessionId)?.exclusiveTags).toEqual(['resource-a'])
    expect(f.engine.journal.projection.resources.get(next)?.exclusiveTags).toEqual([])
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(old.sessionId)
    expect(await f.seats.open({ seat: definition.seat, origin: 'manual', operationId: operation('ordinary') }))
      .toMatchObject({ status: 'choice-required', choices: ['switch', 'replace', 'cancel'] })
    const remote = f.ctx.get('seats')!.withAuthority({ ...f.authority, origin: 'remote' })
    expect(await remote.open({ seat: definition.seat, origin: 'remote', operationId: operation('remote-ordinary') }))
      .toMatchObject({ status: 'rejected', error: { code: 'seat-already-open' } })
    expect(await f.seats.replace({ sessionId: old.sessionId, operationId: operation('another-replace') }))
      .toMatchObject({ status: 'rejected', error: { code: 'state-conflict' } })
    const agent = f.ctx.agents.get(next)!
    await completesIdleTurn(f.ctx, agent, () => { release.resolve(undefined) })
    expect(await f.ctx.sessions.flush(agent.session)).toBe(true)
    await commitsEffect(f.ctx, effect => effect.kind === 'window/replacement'
      && effect.data.phase === (failed ? 'failed' : 'completed'), () => f.engine.drive())
    const settled = f.engine.journal.projection.replacements.get(transaction.replacementId)
    expect(settled).toMatchObject({ phase: failed ? 'failed' : 'completed',
      permit: { state: failed ? 'expired-failure' : 'expired-success' } })
    expect(f.engine.journal.projection.resources.size).toBe(1)
    expect(f.engine.journal.projection.resources.get(failed ? old.sessionId : next)?.exclusiveTags).toEqual(['resource-a'])
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(failed ? next : old.sessionId)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(failed ? old.sessionId : next)
    if (failed) expect([...f.engine.journal.projection.callbacks.values()].find(item => item.payload.kind === 'replacement-failed')?.payload)
      .toMatchObject({ kind: 'replacement-failed', oldSessionId: old.sessionId,
        newSessionId: next, reason: 'replacement-first-turn-failed', cleanup: 'closed',
        cause: { code: 'replacement-first-turn-failed', message: 'Replacement first turn did not complete' } })
    expect(f.engine.journal.projection.opens.size).toBe(2)
  } finally { release.resolve(undefined); await f.close() }
})
