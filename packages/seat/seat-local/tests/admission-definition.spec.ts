/** Invalid opening templates are refused before any Session or source admission. */
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it.each(['manual', 'external'] as const)('names a bad definition before %s opening without stopping the engine', async (entry) => {
  const f = await admissionHost(undefined, { ownerObserveIntervalMs: 60000 })
  const sourceId = 'definition-source' as T.SeatSourceId
  const callback = vi.fn(async (_payload: T.SeatCallbackPayload) => {})
  const release = f.engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback })
  try {
    await f.seats.save({ definition: { ...f.definition, opening: { kind: 'text', text: '{{unsupported}}' } },
      expectedRevision: 2, operationId: operation('bad-template') })
    const result = entry === 'manual'
      ? await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('bad-open') })
      : await f.engine.accept({ triggerId: 'bad-trigger' as T.TriggerId, eventId: 'bad-event' as T.SourceEventId,
        sourceId, callbackRef: sourceId, kind: 'external', evidence: { kind: 'external', eventType: 'bad' },
        seat: f.definition.seat, projectId: f.definition.projectId, receivedAt: new Date().toISOString(), data: null,
        dataDigest: 'bad-digest' as T.SeatDigest })
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition', effectState: 'none', retryable: false } })
    if (result.status !== 'rejected') throw new Error('Expected definition refusal')
    expect(result.error).toMatchInlineSnapshot(`
      {
        "alternative": "Repair the seat opening template or configuration and submit again. 请修好该工位开场模板或配置后重新提交。",
        "code": "invalid-definition",
        "effectState": "none",
        "message": "Seat \"seat-a\" has an invalid definition; admission was refused. 工位“seat-a”定义无效，准入已拒绝。",
        "retryable": false,
      }
    `)
    expect(f.engine.journal.projection.opens.size).toBe(0)
    expect(f.engine.journal.projection.pending.size).toBe(0)
    expect(f.ctx.agents.list()).toHaveLength(0)
    expect(callback).not.toHaveBeenCalled()
    expect((await f.engine.nodeStatus()).engine).toBe('running')
  } finally { await release(); await f.close() }
}, 15000)

it.each(['manual', 'external'] as const)('preserves unknown file failures at %s opening', async (entry) => {
  const f = await admissionHost(undefined, { ownerObserveIntervalMs: 60000 })
  const sourceId = 'unreadable-source' as T.SeatSourceId
  const release = f.engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
  try {
    await f.seats.save({ definition: { ...f.definition, opening: { kind: 'file', path: join(f.options.directory, 'missing-opening.md') } },
      expectedRevision: 2, operationId: operation('unreadable-template') })
    const opening = entry === 'manual'
      ? f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('unreadable-open') })
      : f.engine.accept({ triggerId: 'unreadable-trigger' as T.TriggerId, sourceId, callbackRef: sourceId,
        kind: 'external', evidence: { kind: 'external', eventType: 'unreadable' }, seat: f.definition.seat,
        projectId: f.definition.projectId, receivedAt: new Date().toISOString(), data: null,
        dataDigest: 'unreadable-digest' as T.SeatDigest })
    await expect(opening).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.engine.journal.projection.opens.size).toBe(0)
    expect(f.ctx.agents.list()).toHaveLength(0)
    expect((await f.engine.nodeStatus()).engine).toBe('running')
  } finally { await release(); await f.close() }
}, 15000)
