import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import StorageService from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import type { SeatPrincipalId } from '@panedesk/dsh-seat'
import * as Local from '../src/index.ts'
import { definition, nodeId } from './fixtures.ts'
import { seatsReady } from '../../seat/tests/completion.ts'

it('loads the catalog through Loader, rejects operations without an engine and releases the service and lock on unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-composition-'))
  const ctx = new Context()
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  try {
    await ctx.plugin(StorageService)
    ctx.storage.backend.register('json', backend)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.local = Local
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const config: Local.Config = { directory: root, nodeId, nodeName: 'node-a', nodeAliases: { 'node-a': nodeId },
      defaults: definition(root), maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
      pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' }
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([{ name: 'cordis:local', config }]))
    const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    await seatsReady(ctx)
    expect(ctx.get('seats')).toBeDefined()
    const seats = ctx.get('seats')
    if (seats === undefined) throw new Error('Seat provider was not installed')
    const scoped = seats.withAuthority({ principalId: 'user-a' as SeatPrincipalId, nodeId, origin: 'manual' })
    expect(await scoped.definitions({})).toEqual({ definitions: [], revision: 0, complete: true })
    const sourcePath = join(root, 'source.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\nseat-b,model-b\n')
    const preview = await scoped.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    if (!('planId' in preview)) throw new Error('Import preview was rejected')
    expect(await scoped.commitImport({ planId: preview.planId, selectedRows: preview.rows.map(row => row.row),
      expectedRevision: 0, operationId: 'import-a' as never })).toMatchObject({ status: 'committed', revision: 1 })
    expect((await scoped.definitions({})).definitions.map(item => [item.seat, item.revision, item.source?.authority]))
      .toEqual([['seat-a', 1, 'import-source'], ['seat-b', 1, 'import-source']])
    expect(await scoped.setAuthority({ authority: 'seat-store', authorizationRef: 'user-a' as never,
      expectedRevision: 1, operationId: 'authority-a' as never })).toMatchObject({ status: 'saved', revision: 2 })
    expect((await scoped.definitions({})).definitions.map(item => [item.seat, item.revision, item.source?.authority]))
      .toEqual([['seat-a', 2, 'seat-store'], ['seat-b', 2, 'seat-store']])
    expect(await scoped.list({})).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    await ctx.loader.resolve(entry).fiber?.dispose()
    expect(ctx.get('seats')).toBeUndefined()
    const reopened = await import('../src/store.ts').then(module => module.SeatStore.open(facility, root))
    await reopened.close()
  } finally {
    await ctx.fiber.dispose()
    await facility.closeAll()
    await backend.close()
    await rm(root, { recursive: true, force: true })
  }
})
