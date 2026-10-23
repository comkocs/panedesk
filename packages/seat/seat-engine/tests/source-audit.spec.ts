/** External refusals share engine durability without entering the opening queue. */
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SeatEngineService, SeatSourceId } from '@panedesk/dsh-seat'
import { digest } from '../src/journal.ts'
import { rejected } from '../src/triggers.ts'
import { harness, sourceId, trigger } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() { const h = await harness(); cleanups.push(h.close); return h }
const observedAt = '2026-01-01T00:00:00Z'
const request = (code: 'source-not-found' | 'unauthorized'): Parameters<SeatEngineService['auditSourceRejection']>[0] => ({
  sourceId: code === 'source-not-found' ? 'unregistered-a' as SeatSourceId : sourceId,
  digest: digest(null), observedAt, error: rejected(code, 'External source request was rejected.').error,
})

describe('external source rejection audit', () => {
  it('persists unregistered and unauthorized refusals without changing the opening queue', async () => {
    const h = await setup()
    await h.engine.accept(trigger())
    const pending = (await h.engine.pending({ limit: 10 })).items
    for (const code of ['source-not-found', 'unauthorized'] as const) await h.engine.auditSourceRejection(request(code))
    expect((await h.engine.pending({ limit: 10 })).items).toEqual(pending)
    expect(h.creates).toEqual([])
    await h.engine.shutdown()
    const restarted = await h.start()
    const facts = await restarted.query({ kinds: ['source/rejected'], limit: 10 })
    expect(facts.effects).toMatchObject(['source-not-found', 'unauthorized'].map(code => ({
      kind: 'source/rejected', data: { sourceEventId: null, digest: digest(null), error: { code } },
    })))
    expect(restarted.journal.projection.decisions.slice(1).map(decision => decision.observedAt)).toEqual([observedAt, observedAt])
    expect((await restarted.pending({ limit: 10 })).items).toEqual(pending)
  })

  it('rejects when source rejection storage fails without publishing a fact', async () => {
    const h = await setup()
    const events = join(h.engine.journal.root, 'events')
    await rename(events, `${events}-saved`)
    await writeFile(events, 'Storage is unavailable.')
    await expect(h.engine.auditSourceRejection(request('source-not-found'))).rejects.toThrow('Engine commit outcome requires recovery')
    expect((await h.engine.query({ kinds: ['source/rejected'], limit: 10 })).effects).toEqual([])
    expect(h.engine.journal.projection.sequence).toBe(0)
    expect((await h.engine.pending({ limit: 10 })).items).toEqual([])
  })
})
