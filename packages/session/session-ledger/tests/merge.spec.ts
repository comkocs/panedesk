import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { appendUnique, importSegments, recoverSegments } from '../src/journal.ts'
import { options } from './fixtures.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
import { mergeLedger, foldLedger } from '../src/projection.ts'
import { event } from './fixtures.ts'

describe('multi-node merge', () => {
  it('imports validated node segments and preserves source identities across replay', async () => {
    const source = await mkdtemp(join(import.meta.dirname, '.merge-source-'))
    const target = await mkdtemp(join(import.meta.dirname, '.merge-target-'))
    roots.push(source, target)
    await appendUnique(source, event(), options)
    expect((await importSegments(target, source, options)).map(result => result.kind)).toEqual(['appended'])
    expect((await importSegments(target, source, options)).map(result => result.kind)).toEqual(['existing'])
    expect((await recoverSegments(target, options.maxRecordBytes)).events).toEqual([event()])
  })
  it('deduplicates identical imported calls without billing their lifecycle twice', () => {
    const result = mergeLedger([[event(), event('call/end')], [event(), event('call/end')]])
    expect(result.events).toHaveLength(2)
    expect(result.conflicts).toHaveLength(0)
    expect(foldLedger(result.events, { asOf: 300, observationMaxAgeMs: 100 }).rows).toHaveLength(1)
  })
  it('retains both sides of conflicting node facts and excludes their call from totals', () => {
    const other = event()
    other.nodeId = 'node-b' as typeof other.nodeId
    other.eventId = 'import-b' as typeof other.eventId
    if (other.kind === 'call/start') other.data.nodeId = other.nodeId
    const merged = mergeLedger([[event()], [other]])
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]).toEqual({ existing: event(), incoming: other })
    expect(merged.events).toHaveLength(0)
  })
  it('associates descendant sessions through explicit parent links', () => {
    const child = event()
    child.callId = 'call-child' as NonNullable<typeof child.callId>
    child.eventId = 'event-child' as typeof child.eventId
    child.sessionId = 'session-child' as typeof child.sessionId
    if (child.kind === 'call/start') child.data = { ...child.data, callId: child.callId, sessionId: child.sessionId, parentSessionId: event().sessionId }
    const filter = { sessionId: event().sessionId, includeChildren: true }
    expect(foldLedger([event(), child], { asOf: 300, observationMaxAgeMs: 100, filter }).rows).toHaveLength(2)
  })
})
