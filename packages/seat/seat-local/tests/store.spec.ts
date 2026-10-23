import { afterEach, describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
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
})
