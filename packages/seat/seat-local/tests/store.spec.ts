import { afterEach, describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SeatDigest, SeatRuleId } from '@panedesk/dsh-seat'
import { SeatStore, setCatalogAuthority } from '../src/store.ts'
import { definition, operation, storeFixture } from './fixtures.ts'

const fixtures: Awaited<ReturnType<typeof storeFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })

describe('catalog ownership', () => {
  it('persists catalog, baseline and operation receipt atomically and rejects stale CAS', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const { store, root } = fixture
    const request = { value: 'definition-a' }
    expect(await store.mutate(0, operation('save-a'), request, (catalog) => { catalog.definitions.push(definition(root)) })).toBe(1)
    expect(await store.mutate(0, operation('save-a'), request, () => { throw new Error('Replay must not mutate') })).toBe(1)
    await expect(store.mutate(1, operation('save-a'), { value: 'other' }, () => {})).rejects.toMatchObject({ failure: { code: 'operation-id-conflict' } })
    await expect(store.mutate(0, operation('save-b'), {}, () => {})).rejects.toMatchObject({ failure: { code: 'revision-conflict' } })
    await store.close()
    const reopened = await SeatStore.open(fixture.facility, root)
    try {
      expect(reopened.snapshot().definitions).toEqual([definition(root)])
      expect(reopened.snapshot().operations['save-a']?.revision).toBe(1)
    } finally { await reopened.close() }
    expect((await stat(join(root, 'catalog.lock'))).mode & 0o777).toBe(0o600)
  })

  it('does not steal a live writer and releases ownership after draining', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const error: unknown = await SeatStore.open(fixture.facility, fixture.root).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error && 'code' in error ? error.code : null).toMatch(/EAGAIN|EWOULDBLOCK/)
    const writes = fixture.store.mutate(0, operation('authority-a'), {}, (catalog) => {
      setCatalogAuthority(catalog, 'seat-store', 'authorization-a')
    })
    await fixture.store.close()
    await expect(writes).resolves.toBe(1)
    const next = await SeatStore.open(fixture.facility, fixture.root)
    try { expect(next.snapshot().authority).toBe('seat-store'); expect(next.snapshot().authorizations).toHaveLength(1) }
    finally { await next.close() }
  })

  it('advances only the per-seat revision whose source authority actually changes', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const { store, root } = fixture
    const sourced = (seat: string, revision: number, authority: 'import-source' | 'seat-store') => definition(root, {
      seat: seat as never, revision, source: { sourcePath: join(root, 'source.csv'), sourceFileHash: 'a'.repeat(64) as SeatDigest,
        rowHash: 'b'.repeat(64) as SeatDigest, mappingHash: 'c'.repeat(64) as SeatDigest, columnHashes: {}, baseline: {}, authority },
    })
    await store.mutate(0, operation('import-source'), { value: 'import' }, (catalog) => {
      catalog.authority = 'import-source'
      catalog.definitions.push(sourced('seat-a', 1, 'import-source'), sourced('seat-b', 4, 'import-source'), definition(root, { seat: 'seat-c' as never, revision: 2 }))
    })
    const before = store.snapshot().definitions.map(item => [item.seat, item.revision, item.source?.authority])
    expect(before).toEqual([['seat-a', 1, 'import-source'], ['seat-b', 4, 'import-source'], ['seat-c', 2, undefined]])
    const request = { authority: 'seat-store', authorizationRef: 'authorization-a' }
    expect(await store.mutate(1, operation('authority-switch'), request, (catalog) => {
      setCatalogAuthority(catalog, 'seat-store', 'authorization-a')
    })).toBe(2)
    const switched = store.snapshot()
    expect(switched.revision).toBe(2)
    expect(switched.authority).toBe('seat-store')
    expect(switched.definitions.map(item => [item.seat, item.revision, item.source?.authority])).toEqual([
      ['seat-a', 2, 'seat-store'], ['seat-b', 5, 'seat-store'], ['seat-c', 2, undefined],
    ])
    expect(await store.mutate(2, operation('authority-back'), { authority: 'import-source' }, (catalog) => {
      setCatalogAuthority(catalog, 'import-source', 'authorization-b')
    })).toBe(3)
    expect(store.snapshot().definitions.map(item => [item.seat, item.revision, item.source?.authority])).toEqual([
      ['seat-a', 3, 'import-source'], ['seat-b', 6, 'import-source'], ['seat-c', 2, undefined],
    ])
    expect(await store.mutate(3, operation('authority-same'), { authority: 'import-source' }, (catalog) => {
      setCatalogAuthority(catalog, 'import-source', 'authorization-c')
    })).toBe(4)
    expect(store.snapshot().definitions.map(item => item.revision)).toEqual([3, 6, 2])
    expect(store.snapshot().revision).toBe(4)
    expect(await store.mutate(3, operation('authority-back'), { authority: 'import-source' }, () => { throw new Error('Replay must not mutate') })).toBe(3)
    expect(store.snapshot().definitions.map(item => item.revision)).toEqual([3, 6, 2])
    expect(store.snapshot().revision).toBe(4)
    await expect(store.mutate(4, operation('authority-back'), { authority: 'seat-store' }, () => {})).rejects.toMatchObject({ failure: { code: 'operation-id-conflict' } })
  })

  it('rejects a same-numbered definition whose content differs and keeps the stored revision', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const { store, root } = fixture
    const first = definition(root, { revision: 3, model: 'model-a' })
    await store.mutate(0, operation('content-a'), { value: 'a' }, (catalog) => {
      catalog.authority = 'seat-store'
      catalog.definitions.push(first)
    })
    const changed = definition(root, { revision: 3, model: 'model-b' })
    await expect(store.mutate(1, operation('content-b'), { planId: 'content-plan', selectedRows: [1], value: 'b' }, (catalog) => {
      catalog.definitions[0] = changed
    })).rejects.toMatchObject({ failure: { code: 'revision-conflict' } })
    expect(store.snapshot().definitions[0]?.model).toBe('model-a')
    expect(store.snapshot().definitions[0]?.revision).toBe(3)
    expect(store.snapshot().revision).toBe(1)
  })

  it('serializes overlapping catalog commits so the later writer rereads the conflict', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const { store, root } = fixture
    await store.mutate(0, operation('race-base'), {}, (catalog) => {
      catalog.authority = 'seat-store'
      catalog.definitions.push(definition(root))
    })
    const first = store.mutate(1, operation('race-a'), { value: 'a' }, (catalog) => {
      catalog.definitions[0] = definition(root, { revision: 2, model: 'model-a' })
    })
    const second = store.mutate(1, operation('race-b'), { value: 'b' }, (catalog) => {
      catalog.definitions[0] = definition(root, { revision: 2, model: 'model-b' })
    })
    const settled = await Promise.allSettled([first, second])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(2)
    expect(store.snapshot().revision).toBe(2)
    expect(store.snapshot().definitions).toHaveLength(1)
    expect(['model-a', 'model-b']).toContain(store.snapshot().definitions[0]?.model)
  })

  it('counts source-directory seat rules toward the configured seat limit', async () => {
    const fixture = await storeFixture(); fixtures.push(fixture)
    const { store, root } = fixture
    const rule = { id: 'source-rule' as SeatRuleId, enabled: true, trigger: { kind: 'manual' as const, origin: 'manual' as const },
      timeWindows: [], exclusiveTags: [] as string[] }
    const sourceSeat = definition(root, { seat: 'source-seat' as never, rules: [rule] })
    await expect(store.mutate(0, operation('source-rule-limit'), { maxSeats: 1 }, (catalog) => {
      catalog.definitions.push(sourceSeat, definition(root, { seat: 'local-seat' as never }))
    }, 'revision-conflict', 1)).rejects.toMatchObject({ failure: { code: 'unavailable' } })
    expect(store.snapshot().definitions).toHaveLength(0)
    expect(store.snapshot().revision).toBe(0)
  })
})
