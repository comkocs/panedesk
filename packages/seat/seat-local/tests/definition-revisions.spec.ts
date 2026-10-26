/** Exact revision observations use real issuer ownership and the Loader-owned local provider. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function request(seat: T.SeatName): T.SeatDefinitionRevisionRequest {
  return { seat, sourceId: 'remote-source' as T.SeatSourceId, sourceOwnerNodeId: sender,
    ownerEpoch: 'owner-epoch' as T.OwnerEpoch, openingMethod: 'seat.openFrozen', taskIds: [] }
}

test('reads only the local definition revision with live independent authority and no journal effects', async () => {
  const { h, authorize } = await frozenHost()
  try {
    const provider = h.ctx.get('seatDefinitionRevisions')!, payload = request(h.definition.seat)
    const operationId = 'revision-read' as T.SeatOperationId, authority = await authorize(payload, operationId)
    expect(provider.available()).toBe(false)
    expect(await provider.read(payload, authority)).toMatchObject({ status: 'rejected' })
    await provider.ready()
    const before = h.engine.journal.projection.sequence
    expect(await provider.read(payload, authority)).toEqual({ status: 'found', nodeId: h.options.nodeId,
      seat: payload.seat, revision: h.definition.revision })
    expect((await h.seats.definitions({})).revision).not.toBe(h.definition.revision)
    for (const patch of [{ seat: 'other' as T.SeatName }, { sourceId: 'other' as T.SeatSourceId },
      { ownerEpoch: 'other' as T.OwnerEpoch }, { sourceOwnerNodeId: 'third-node' as T.SeatNodeId }]) {
      expect(await provider.read({ ...payload, ...patch }, authority)).toMatchObject({ status: 'rejected' })
    }
    for (const changed of [{ ...authority, nodeId: sender }, { ...authority, principalId: 'other' as T.SeatPrincipalId },
      { ...authority, authorization: { ...authority.authorization } }]) {
      expect(await provider.read(payload, changed)).toMatchObject({ status: 'rejected' })
    }
    const wrongSource = { ...payload, sourceId: 'other' as T.SeatSourceId }
    expect(await provider.read(wrongSource, await authorize(wrongSource, operationId))).toMatchObject({ status: 'rejected',
      error: { cause: { reasonCode: 'remote-open-not-allowed' } } })
    expect(h.engine.journal.projection.sequence).toBe(before)
    h.engine.authorizationIssuers.close()
    expect(await provider.read(payload, authority)).toMatchObject({ status: 'rejected' })
    expect(h.engine.journal.projection.sequence).toBe(before)
  } finally { await h.close() }
})

test('refuses a remote catalog row without exposing its definition or attempting remote resolution', async () => {
  const { h } = await frozenHost()
  try {
    const sourcePath = join(h.options.directory, 'remote-revision.csv')
    await writeFile(sourcePath, 'seat,node\nremote-seat,third-node\n')
    const base = (await h.seats.definitions({})).definitions[0]!
    await h.seats.setAuthority({ authority: 'import-source', authorizationRef: 'user-a' as T.AuthorizationRef,
      expectedRevision: (await h.seats.definitions({})).revision, operationId: 'remote-import-authority' as T.SeatOperationId })
    const plan = await h.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', node: 'node' }, defaults: base })
    if ('status' in plan) throw new Error('Expected import plan')
    expect(await h.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row),
      expectedRevision: (await h.seats.definitions({})).revision, operationId: 'remote-row' as T.SeatOperationId }))
      .toMatchObject({ status: 'committed' })
    expect((await h.seats.definitions({})).definitions.find(row => row.seat === 'remote-seat')?.node).toBe('third-node')
    const provider = h.ctx.get('seatDefinitionRevisions')!, payload = request('remote-seat' as T.SeatName)
    await provider.ready()
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: h.options.nodeId, origin: 'remote', seat: payload.seat, taskIds: [], policyRevision: 1, sourceNodeId: sender },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const authorization = await entry.issuer.check({ operationId: 'remote-row-read' as T.SeatOperationId, requestDigest: digest(payload) })
    if ('status' in authorization) throw new Error('Expected read grant')
    const result = await provider.read(payload, { principalId, origin: 'remote', nodeId: h.options.nodeId, authorization })
    expect(result).toMatchObject({ status: 'rejected' })
    expect(JSON.stringify(result)).not.toContain('third-node')
    expect(JSON.stringify(result)).not.toContain(sourcePath)
  } finally { await h.close() }
})

test('finds an authorized exact definition beyond the first catalog page without exposing the catalog revision', async () => {
  const { h } = await frozenHost()
  try {
    const base = (await h.seats.definitions({})).definitions[0]!
    let catalogRevision = (await h.seats.definitions({})).revision
    for (let i = 0; i < h.options.pageSize; i++) {
      const result = await h.seats.save({ definition: { ...base, seat: `page-seat-${i}` as T.SeatName, revision: 17 },
        expectedRevision: catalogRevision, operationId: `page-save-${i}` as T.SeatOperationId })
      if (result.status !== 'saved') throw new Error('Expected catalog save')
      catalogRevision = result.revision
    }
    const payload = request(`page-seat-${h.options.pageSize - 1}` as T.SeatName)
    const page = await h.seats.definitions({})
    expect(page.complete).toBe(false)
    expect(page.definitions.some(definition => definition.seat === payload.seat)).toBe(false)
    const entry = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
      nodeId: h.options.nodeId, origin: 'remote', seat: payload.seat, taskIds: [], policyRevision: 1, sourceNodeId: sender },
    current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
    const authorization = await entry.issuer.check({ operationId: 'page-read' as T.SeatOperationId, requestDigest: digest(payload) })
    if ('status' in authorization) throw new Error('Expected read grant')
    const provider = h.ctx.get('seatDefinitionRevisions')!
    await provider.ready()
    expect(await provider.read(payload, { principalId, origin: 'remote', nodeId: h.options.nodeId, authorization }))
      .toEqual({ status: 'found', nodeId: h.options.nodeId, seat: payload.seat, revision: 17 })
    expect(catalogRevision).not.toBe(17)
  } finally { await h.close() }
})

test('rechecks grant revocation after asynchronous local resolution', async () => {
  const { h, authorize } = await frozenHost()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  try {
    const provider = h.ctx.get('seatDefinitionRevisions')!, payload = request(h.definition.seat)
    await provider.ready()
    const authority = await authorize(payload, 'revision-revocation' as T.SeatOperationId)
    const seats = h.ctx.get('seats')!, resolve = seats.resolve.bind(seats)
    vi.spyOn(seats, 'resolve').mockImplementation(async (seat) => {
      entered.resolve(undefined); await release.promise; return resolve(seat)
    })
    const reading = provider.read(payload, authority)
    await entered.promise
    h.engine.authorizationIssuers.close()
    release.resolve(undefined)
    expect(await reading).toMatchObject({ status: 'rejected' })
  } finally { release.resolve(undefined); await h.close() }
})

test('withdraws captured revision providers and drains in-flight resolution during Loader replacement', async () => {
  const { h, authorize } = await frozenHost()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  try {
    const provider = h.ctx.get('seatDefinitionRevisions')!, payload = request(h.definition.seat)
    await provider.ready()
    const authority = await authorize(payload, 'revision-lifecycle' as T.SeatOperationId)
    const seats = h.ctx.get('seats')!, resolve = seats.resolve.bind(seats)
    vi.spyOn(seats, 'resolve').mockImplementation(async (seat) => { entered.resolve(undefined); await release.promise; return resolve(seat) })
    const reading = provider.read(payload, authority)
    await entered.promise
    let completed = false
    const replacing = h.reload().then(() => { completed = true })
    await expect.poll(() => provider.available()).toBe(false)
    expect(completed).toBe(false)
    expect(await provider.read(payload, authority)).toMatchObject({ status: 'rejected' })
    release.resolve(undefined)
    expect(await reading).toMatchObject({ status: 'rejected' })
    await replacing
    await expect.poll(() => h.ctx.get('seatDefinitionRevisions')).toBeDefined()
    const replacement = h.ctx.get('seatDefinitionRevisions')!
    expect(replacement).not.toBe(provider)
    expect(replacement.available()).toBe(false)
    await replacement.ready()
    expect(replacement.available()).toBe(true)
    await expect(provider.ready()).rejects.toThrow('withdrawn')
  } finally { release.resolve(undefined); await h.close() }
})
