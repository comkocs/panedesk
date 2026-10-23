/** Accepted prefill survives catalog edits, source-file edits and midnight without model dispatch. */
import { expect, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import type { engineFixture } from './engine-fixture.ts'
import type { CreationAdapter } from './creation-provider.ts'
import { operation } from './fixtures.ts'

/** Queue a public prefill before midnight and recover it under the next catalog revision.
 * @param f - real production local provider and engine.
 * @param seats - authenticated public caller.
 * @param adapter - deterministic model transport observer.
 */
export async function checkFrozenPrefill(f: Awaited<ReturnType<typeof engineFixture>>, seats: T.SeatService,
  adapter: CreationAdapter): Promise<void> {
  const template = join(f.options.directory, 'opening.txt')
  await writeFile(template, 'Original {{seat}} {{date}}')
  const catalog = await seats.definitions({})
  const original = { ...f.definition, seat: 'seat-frozen' as T.SeatName, revision: 7,
    opening: { kind: 'file' as const, path: template }, rules: [] }
  expect(await seats.save({ definition: original, expectedRevision: catalog.revision,
    operationId: operation('save-frozen') })).toMatchObject({ status: 'saved' })
  const held = vi.spyOn(f.engine, 'drive').mockResolvedValue()
  const request = { seat: original.seat, origin: 'manual' as const, openingMode: 'prefill' as const,
    operationId: operation('open-frozen') }
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T23:59:00.000Z'))
    expect(await seats.open(request)).toMatchObject({ status: 'queued' })
    const current = await seats.definitions({})
    expect(await seats.save({ definition: { ...original, revision: 8, opening: { kind: 'text', text: 'Changed' } },
      expectedRevision: current.revision, operationId: operation('edit-frozen') })).toMatchObject({ status: 'saved' })
    await writeFile(template, 'Changed file')
    vi.setSystemTime(new Date('2026-01-02T00:01:00.000Z'))
    held.mockRestore()
    await f.engine.drive()
    const result = await seats.open(request)
    expect(result).toMatchObject({ status: 'prefilled', title: 'seat-frozen 01-01', draft: 'Original seat-frozen 2026-01-01' })
    if (result.status !== 'prefilled') throw new Error('Prefill was not retained')
    const open = f.engine.journal.projection.opens.get(result.sessionId)
    expect(open).toMatchObject({ phase: 'active', openingMode: 'prefill', openingMessageId: null,
      definition: { revision: 7 }, frozenOpening: { text: result.draft }, title: result.title })
    expect(f.ctx.sessionTitle.get(f.ctx.agents.get(result.sessionId)!.session)?.title).toBe(result.title)
    expect(f.ctx.agents.get(result.sessionId)?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    await f.engine.drive()
    expect(f.engine.journal.projection.opens.get(result.sessionId)?.frozenOpening?.text).toBe(result.draft)
    expect(adapter.requests).toHaveLength(0)
  } finally { held.mockRestore(); vi.useRealTimers() }
}
