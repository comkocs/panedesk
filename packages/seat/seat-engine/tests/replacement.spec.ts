import { afterEach, expect, it } from 'vitest'
import { commitsEffect } from '../../seat/tests/completion.ts'
import type * as T from '@panedesk/dsh-seat'
import { EngineError } from '../src/journal.ts'
import { auto, harness, seat, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function setup(limit = 2) {
  const h = await harness({ nodeEngineWindowLimit: limit }); cleanups.push(h.close)
  const definition = h.definitions.get(seat)
  if (!definition) throw new Error('Missing definition')
  definition.maxOpenSessions = 2
  definition.rules = [{ id: 'rule-a' as T.SeatRuleId, enabled: true,
    trigger: { kind: 'external', sourceId: trigger().sourceId }, timeWindows: [], exclusiveTags: ['tag-a'] }]
  await auto(h.engine); await h.engine.accept(trigger()); await h.engine.drive()
  const old = h.creates[0]
  if (!old) throw new Error('Missing old window')
  const request: T.ReplaceSeatRequest = { sessionId: old, operationId: 'replace-a' as T.SeatOperationId }
  return { ...h, old, request }
}
it('queues replacement at two-window capacity without reserving tags', async () => {
  const h = await setup(1)
  expect(await h.engine.replace(h.request)).toMatchObject({ status: 'queued' })
  await h.engine.drive()
  expect(h.creates).toEqual([h.old])
  expect([...h.engine.journal.projection.pending.values()]).toMatchObject([{ reason: 'node-capacity' }])
  expect(h.engine.journal.projection.resources.size).toBe(1)
  expect(h.engine.journal.projection.resources.get(h.old)?.exclusiveTags).toEqual(['tag-a'])
  h.engine.options.config.nodeEngineWindowLimit = 2
  await h.engine.drive()
  expect(h.creates).toHaveLength(2)
  expect(h.closed).toEqual([h.old])
})
it('binds one permit to one replacement and transfers tags only after old close', async () => {
  const h = await setup(); h.state.opening = 'pending'
  const first = await h.engine.replace(h.request)
  expect(await h.engine.replace(h.request)).toEqual(first)
  await h.engine.drive()
  const next = h.creates[1]
  if (!next) throw new Error('Missing replacement')
  expect(h.engine.journal.projection.resources.get(h.old)?.exclusiveTags).toEqual(['tag-a'])
  expect(h.engine.journal.projection.resources.get(next)?.exclusiveTags).toEqual([])
  expect(h.closed).toEqual([])
  h.state.opening = 'completed'; await h.engine.drive()
  const replacement = [...h.engine.journal.projection.replacements.values()][0]
  expect(replacement).toMatchObject({ phase: 'completed', permit: { state: 'expired-success', newSessionId: next } })
  expect(h.engine.journal.projection.resources.get(next)?.exclusiveTags).toEqual(['tag-a'])
  expect(h.engine.journal.projection.resources.has(h.old)).toBe(false)
  await h.engine.replace(h.request); await h.engine.drive()
  expect(h.creates).toHaveLength(2)
})
it('transfers old tags when the old window closes before the first reply', async () => {
  const h = await setup(); h.state.opening = 'pending'
  await h.engine.replace(h.request); await h.engine.drive()
  const next = h.creates[1]
  if (!next) throw new Error('Missing replacement')
  await h.engine.recordClosed({ sessionId: h.old, phase: 'closed', reason: 'manual', stateVersion: 2,
    endedAt: new Date().toISOString(), reportId: null, selfReport: null, selfReportStatus: 'not-submitted' })
  expect(h.engine.journal.projection.resources.get(next)?.exclusiveTags).toEqual(['tag-a'])
  h.state.opening = 'completed'; await h.engine.drive()
  expect([...h.engine.journal.projection.replacements.values()]).toMatchObject([{ phase: 'completed' }])
  expect(h.closed).toEqual([])
})
it.each(['absent', 'first-turn'] as const)('cleans failed replacement %s without touching the old window', async (failure) => {
  const h = await setup()
  if (failure === 'absent') h.executor.create = () => Promise.reject(new EngineError('open-create-failed', 'Create failed'))
  else h.state.opening = 'failed'
  await commitsEffect(h.engine.ctx, effect => effect.kind === 'callback/delivered'
    && effect.data.payload.kind === 'replacement-failed' && effect.data.payload.oldSessionId === h.old,
  async () => { await h.engine.replace(h.request); await h.engine.drive() })
  const replacement = [...h.engine.journal.projection.replacements.values()][0]
  expect(replacement).toMatchObject({ phase: 'failed', cleanup: failure === 'absent' ? 'not-created' : 'closed',
    permit: { state: 'expired-failure' } })
  expect(h.engine.journal.projection.resources.get(h.old)?.exclusiveTags).toEqual(['tag-a'])
  expect(h.closed).not.toContain(h.old)
  expect(h.engine.journal.projection.resources.size).toBe(1)
  expect(h.callbacks.find(item => item.kind === 'replacement-failed')).toMatchObject({
    oldSessionId: h.old, cleanup: failure === 'absent' ? 'not-created' : 'closed',
    reason: failure === 'absent' ? 'replacement-open-failed' : 'replacement-first-turn-failed',
  })
})
