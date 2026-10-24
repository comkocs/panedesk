/** Exact rules and source snapshots use the engine journal for commits, deduplication and restart reads. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, seat, sourceId, trigger } from './fixtures.ts'
import { digest } from '../src/journal.ts'

function rule(source = sourceId, eventType?: string): T.SeatRule {
  return { id: 'exact' as T.SeatRuleId, enabled: true, trigger: { kind: 'external', sourceId: source,
    ...(eventType === undefined ? {} : { eventType }) }, mode: 'auto', timeWindows: [], exclusiveTags: [] }
}
it('matches configured external sources and event types exactly without fallback to project automatic mode', async () => {
  const h = await harness()
  try {
    await auto(h.engine)
    const definition = h.definitions.get(seat)!
    definition.rules = [rule('other-source' as T.SeatSourceId)]
    expect(await h.engine.accept(trigger())).toMatchObject({ status: 'rejected', error: { code: 'disabled' } })
    definition.rules = [rule(sourceId, 'other-type')]
    expect(await h.engine.accept(trigger())).toMatchObject({ status: 'rejected' })
    definition.rules = [rule(sourceId, 'event-a')]
    expect(await h.engine.accept(trigger())).toMatchObject({ status: 'accepted' })
    definition.rules = [rule('other-source' as T.SeatSourceId)]
    await h.engine.drive()
    expect(h.creates).toEqual([])
    definition.rules = [rule()]
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})
it('freezes referenced context once, reuses it on retry and restart and rejects changed arguments for the same ID', async () => {
  const h = await harness()
  try {
    const reference: T.OpeningContextReference = { providerId: 'provider-a' as T.OpeningProviderId,
      reference: 'reference-a' as T.OpeningContextReference['reference'], revision: '1' }
    const taskId = 'task-a' as T.SeatTaskId
    const context: T.OpeningContextSnapshot = { reference, text: 'Original source text\n', digest: digest('Original source text\n'),
      revision: '1', taskIds: [taskId], scopeEvidence: [] }
    const freeze = vi.fn(async (definition: T.SeatDefinition): Promise<T.SeatFrozenOpen> => ({ definition,
      title: 'frozen', openingMode: 'auto', openingContext: context,
      frozenOpening: { text: context.text, digest: context.digest, variables: { seat, date: '2026-01-01', taskId } } }))
    const dispose = h.engine.registerLocalAccess({ list: h.seatProvider.list, close: h.seatProvider.close,
      freeze, freezeContext: freeze })
    const input = { ...trigger(), openingContext: reference, relatedTaskIds: [taskId] }
    expect(await h.engine.accept(input)).toMatchObject({ status: 'accepted' })
    expect(await h.engine.accept(input)).toMatchObject({ status: 'duplicate' })
    expect(await h.engine.accept({ ...input, openingContext: { ...reference, revision: '2' } })).toMatchObject({ error: { code: 'event-id-conflict' } })
    expect(freeze).toHaveBeenCalledTimes(1)
    expect([...h.engine.journal.projection.pending.values()][0]).toMatchObject({ relatedTaskIds: [taskId],
      frozenOpen: { openingContext: context } })
    await dispose(); await h.engine.shutdown()
    const restarted = await h.start()
    expect(await restarted.accept(input)).toMatchObject({ status: 'duplicate' })
    expect([...restarted.journal.projection.pending.values()][0]).toMatchObject({ frozenOpen: { openingContext: context } })
  } finally { await h.close() }
})
it('rejects unregistered sources and missing freezers instead of ignoring references and using default templates', async () => {
  const h = await harness()
  try {
    const input: T.TriggerEnvelope = { ...trigger(), openingContext: { providerId: 'p' as T.OpeningProviderId,
      reference: 'r' as T.OpeningContextReference['reference'], revision: '1' }, relatedTaskIds: [] }
    expect(await h.engine.accept(input)).toMatchObject({ error: { code: 'unavailable' } })
    expect(await h.engine.accept({ ...input, sourceId: 'missing' as T.SeatSourceId })).toMatchObject({ error: { code: 'source-not-found' } })
    expect(h.engine.journal.projection.pending.size).toBe(0)
  } finally { await h.close() }
})
