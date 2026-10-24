import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeatName } from '@panedesk/dsh-seat'
import { SeatImporter } from '../src/import.ts'
import { catalogs, operation, storeFixture } from './fixtures.ts'

const fixtures: Awaited<ReturnType<typeof storeFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function setup() {
  const fixture = await storeFixture(); fixtures.push(fixture)
  return { ...fixture, importer: new SeatImporter(fixture.store, catalogs(fixture.root), { maxSourceBytes: 65536, maxPlans: 20 }), sourcePath: join(fixture.root, 'source.csv') }
}

describe('seat import previews', () => {
  it('maps keepalive columns, defaults empty cells to enabled and rejects nonboolean text', async () => {
    const { importer, sourcePath } = await setup()
    await writeFile(sourcePath, 'seat,keep\nseat-a,true\nseat-b,false\nseat-c,\nseat-d,yes\n')
    const plan = await importer.preview({ format: 'csv', sourcePath,
      columnMap: { seat: 'seat', keep: 'autoKeepAlive' }, defaults: {} })
    expect(plan.rows.slice(0, 3).map(row => row.definition?.autoKeepAlive)).toEqual([true, false, true])
    expect(plan.rows[3]).toMatchObject({ action: 'invalid', selected: false })
  })

  it('previews CSV quoted commas and newlines, retains the source hash and commits selected rows only', async () => {
    const { root, importer, sourcePath, store } = await setup()
    await writeFile(sourcePath, 'seat,model\nseat-a,"model,a\nline"\nseat-b,model-b\n')
    const plan = await importer.preview({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    expect(store.snapshot().revision).toBe(0)
    expect(plan.sourceFileHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.rows[0]?.definition?.model).toBe('model,a\nline')
    expect(plan.rows.map(item => item.selected)).toEqual([true, true])
    await importer.commit({ planId: plan.planId, selectedRows: [plan.rows[1]!.row], expectedRevision: 0, operationId: operation('import-a') })
    expect(store.snapshot().definitions.map(item => item.seat)).toEqual(['seat-b'])
    expect(store.snapshot().definitions[0]?.source?.sourceFileHash).toBe(plan.sourceFileHash)
    expect(store.snapshot().definitions[0]?.directories[0]?.path).toBe(root)
  })

  it('parses escaped Markdown pipes and inline code without evaluating cells', async () => {
    const { importer, sourcePath } = await setup()
    await writeFile(sourcePath, '# Seats\n| seat | model |\n| --- | --- |\n| seat-a | `model\\|a` |\n')
    const plan = await importer.preview({ format: 'markdown', sourcePath, table: 'Seats', columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    expect(plan.rows[0]?.definition?.model).toBe('model|a')
    expect(plan.rows[0]?.action).toBe('create')
  })

  it('retains a manually changed seat on source conflict while updating an untouched seat', async () => {
    const { importer, sourcePath, store } = await setup()
    const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} }
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\nseat-b,model-a\n')
    const initial = await importer.preview(request)
    await importer.commit({ planId: initial.planId, selectedRows: initial.rows.map(item => item.row), expectedRevision: 0, operationId: operation('initial') })
    await store.mutate(1, operation('external-edit'), {}, (catalog) => {
      catalog.definitions = catalog.definitions.map(item => item.seat === 'seat-a' ? { ...item, model: 'model-manual' } : item)
    })
    await writeFile(sourcePath, 'seat,model\nseat-a,model-source\nseat-b,model-source\n')
    const plan = await importer.preview(request)
    expect(plan.rows[0]?.action).toBe('conflict')
    expect(plan.rows[0]?.selected).toBe(false)
    expect(plan.rows[0]?.differences).toContainEqual({ field: 'model', baseline: 'model-a', local: 'model-manual', source: 'model-source', conflict: true })
    expect(plan.rows[1]?.action).toBe('update')
    await importer.commit({ planId: plan.planId, selectedRows: plan.rows.map(item => item.row), expectedRevision: 2, operationId: operation('second') })
    expect(store.snapshot().definitions.map(item => item.model)).toEqual(['model-manual', 'model-source'])
  })

  it('retains the entire seat when manual and source edits affect different columns', async () => {
    const { importer, sourcePath, store } = await setup()
    const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} }
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const initial = await importer.preview(request)
    await importer.commit({ planId: initial.planId, selectedRows: [initial.rows[0]!.row], expectedRevision: 0, operationId: operation('initial') })
    await store.mutate(1, operation('manual'), {}, (catalog) => { catalog.definitions[0]!.permissionPreset = 'permission-manual' })
    await writeFile(sourcePath, 'seat,model\nseat-a,model-source\n')
    const plan = await importer.preview(request)
    expect(plan.rows[0]).toMatchObject({ action: 'conflict', selected: false })
    await importer.commit({ planId: plan.planId, selectedRows: [plan.rows[0]!.row], expectedRevision: 2, operationId: operation('second') })
    expect(store.snapshot().definitions[0]).toMatchObject({ model: 'model-a', permissionPreset: 'permission-manual' })
  })

  it('expires persisted previews and reclaims their capacity without changing catalog revision', async () => {
    const { store, root, sourcePath } = await setup()
    const importer = new SeatImporter(store, catalogs(root), { maxSourceBytes: 65536, maxPlans: 1, importPlanTtlMs: 100 })
    await writeFile(sourcePath, 'seat\nseat-a\n')
    const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat' }, defaults: {} }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const plan = await importer.preview(request)
      await expect(importer.preview(request)).rejects.toMatchObject({ failure: { code: 'unavailable' } })
      clock.mockReturnValue(1100)
      await expect(importer.commit({ planId: plan.planId, selectedRows: [2], expectedRevision: 0, operationId: operation('expired') }))
        .rejects.toMatchObject({ failure: { code: 'import-preview-stale' } })
      expect((await importer.preview(request)).planId).not.toBe(plan.planId)
      expect(store.snapshot().revision).toBe(0)
    } finally { clock.mockRestore() }
  })

  it('rejects stale source bytes and leaves invalid duplicate names unselected', async () => {
    const { importer, sourcePath, store } = await setup()
    await writeFile(sourcePath, 'seat\nseat-a\nseat-a\n')
    const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat' }, defaults: {} }
    const plan = await importer.preview(request)
    expect(plan.rows.map(item => [item.action, item.selected])).toEqual([['invalid', false], ['invalid', false]])
    await writeFile(sourcePath, 'seat\nseat-b\n')
    await expect(importer.commit({ planId: plan.planId, selectedRows: [], expectedRevision: 0, operationId: operation('stale') })).rejects.toMatchObject({ failure: { code: 'import-preview-stale' } })
    expect(store.snapshot().definitions.find(item => item.seat === 'seat-b' as SeatName)).toBeUndefined()
  })
})
