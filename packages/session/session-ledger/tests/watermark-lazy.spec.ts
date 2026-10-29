import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as indexStore from '../src/index-store.ts'
import { appendUnique, JournalViewOwner, recoverSegments } from '../src/journal.ts'
import { event, options } from './fixtures.ts'
import type { LedgerEvent, LedgerEventId } from '../src/types.ts'

vi.mock('../src/index-store.ts', async original => ({ ...await original<typeof indexStore>() }))
const roots: string[] = []
const owner = new JournalViewOwner()
afterEach(async () => {
  vi.restoreAllMocks()
  owner.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function fact(id: string): LedgerEvent {
  return { ...event(), kind: 'alert', eventId: id as LedgerEventId,
    alert: { code: 'watermark-fixture', message: 'Synthetic watermark fixture.', redacted: false } }
}

it('defers full watermark hashing and event copying at fifty and one thousand facts', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.watermark-lazy-'))
  roots.push(root)
  const retained = { ...options, viewOwner: owner }
  const counts: { hashes: number; fullHashes: number; fullCopies: number; clones: number }[] = []
  for (let i = 0; i <= 1000; i++) {
    if (i !== 50 && i !== 1000) { await appendUnique(root, fact(String(i)), retained); continue }
    const hashes = vi.spyOn(indexStore, 'digest')
    const flatMaps = vi.spyOn(Array.prototype, 'flatMap')
    const clones = vi.spyOn(globalThis, 'structuredClone')
    const result = await appendUnique(root, fact(String(i)), retained)
    if (result.kind === 'conflict') throw new Error('Unexpected fixture conflict')
    counts.push({ hashes: hashes.mock.calls.length,
      fullHashes: hashes.mock.calls.filter(([text]) => /^[a-f0-9]{64}(\n|$)/.test(text)).length,
      fullCopies: flatMaps.mock.calls.length, clones: clones.mock.calls.length })
    expect(clones.mock.calls).toHaveLength(1)
    expect(clones.mock.calls[0]?.[0]).toEqual(result.event)
    hashes.mockClear()
    flatMaps.mockClear()
    const watermark = result.watermark
    expect(hashes).toHaveBeenCalledTimes(1)
    expect(result.watermark).toBe(watermark)
    const replay = await appendUnique(root, fact(String(i)), retained)
    if (replay.kind === 'conflict') throw new Error('Unexpected replay conflict')
    const fullHashes = () => hashes.mock.calls.filter(([text]) => /^[a-f0-9]{64}(\n|$)/.test(text)).length
    expect(fullHashes()).toBe(1)
    expect(replay.watermark).toBe(watermark)
    expect(fullHashes()).toBe(1)
    vi.restoreAllMocks()
    expect(watermark).toBe((await recoverSegments(root, options.maxRecordBytes)).watermark)
  }
  expect(counts[0]).toEqual(counts[1])
  expect(counts[0]).toEqual({ hashes: 2, fullHashes: 0, fullCopies: 0, clones: 1 })
}, 30000)

it('pins unread acknowledgements across later writes and owner disposal', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.watermark-lazy-'))
  roots.push(root)
  const viewOwner = new JournalViewOwner()
  try {
    const first = await appendUnique(root, fact('first'), { ...options, viewOwner })
    if (first.kind === 'conflict') throw new Error('Unexpected fixture conflict')
    const expected = (await recoverSegments(root, options.maxRecordBytes)).watermark
    await appendUnique(root, fact('second'), { ...options, viewOwner })
    viewOwner.dispose()
    expect(first.watermark).toBe(expected)
    expect({ ...first }.watermark).toBe(expected)
    first.watermark = 'assigned' as typeof expected
    expect(first.watermark).toBe('assigned')
  } finally { viewOwner.dispose() }
})
