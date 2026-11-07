/** Owner-only source preparation keeps existing definitions outside the selected import row. */
import { Context } from '@panedesk/cordis'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeatDefinition, SeatEngineService, SeatService } from '@panedesk/dsh-seat'
import SeatUi from '../src/index.ts'
import StorageService from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import { SeatStore } from '@panedesk/dsh-seat-local/src/store.ts'
import { SeatImporter } from '@panedesk/dsh-seat-local/src/import.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
async function fixture() {
  const root = process.env.PANEDESK_TEST_ROOT ?? tmpdir()
  const home = await mkdtemp(join(root, 'seat-source-'))
  homes.push(home)
  const cwd = join(home, 'work space')
  await mkdir(cwd)
  const ctx = new Context()
  const definitions: SeatDefinition[] = ['existing-a', 'existing-b'].map((name, index) => ({
    schemaVersion: 1, seat: name as SeatDefinition['seat'], revision: index + 2, platform: 'server', node: 'local',
    projectId: `project:${name}` as SeatDefinition['projectId'], directories: [{ path: cwd, startup: true }],
    memoryDirectories: [], opening: { kind: 'text', text: 'Existing opening.' }, openingInstructionFiles: [],
    agentPreset: 'standard', permissionPreset: 'workspace-write', provider: 'provider-a', model: 'model-a',
    reasoningEffort: 'off', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 2,
    subagentContextThresholdTokens: 400000, rules: [],
    worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
  }))
  const service = { definitions: vi.fn(async () => ({ definitions, revision: 3, complete: true })),
    list: vi.fn(async () => ({ status: 'listed' as const, sessions: [], unopenedSeats: [], complete: true, snapshotAt: '' })),
    withAuthority: () => service } as Partial<SeatService> as SeatService
  ctx.provide('seats', service)
  ctx.provide('seatEngine', { nodeStatus: async () => ({ nodeId: 'node-a', nodeName: 'local' }) } as SeatEngineService)
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  return { ctx, ui: new SeatUi(ctx, { home }), home, cwd, definitions,
    request: { name: 'new-seat', directory: cwd, provider: 'provider-a', model: 'model-a', opening: 'Hello.' } }
}

describe('seat source preparation', () => {
  it('computes its path inside home and rejects a UI sourcePath', async () => {
    const f = await fixture()
    try {
      const untrusted = { ...f.request, sourcePath: '/outside.csv' }
      await expect(f.ui.prepareAdd(untrusted)).rejects.toThrow()
      const result = await f.ui.prepareAdd(f.request)
      expect(result.sourcePath.startsWith(`${f.home}/`)).toBe(true)
      expect(result.format).toBe('csv')
      const source = await readFile(result.sourcePath, 'utf8')
      expect(source).toContain('"server"')
      expect(source).toContain('"local"')
      expect(source).toContain('"standard"')
      expect(source).toContain('"workspace-write"')
    } finally { await f.ctx.fiber.dispose() }
  })
  it.each(['name,comma', 'name"quote', '中文工位'])('escapes CSV name %s and preserves two existing rows', async (name) => {
    const f = await fixture()
    try {
      const before = structuredClone(f.definitions)
      const result = await f.ui.prepareAdd({ ...f.request, name })
      const source = await readFile(result.sourcePath, 'utf8')
      expect(source).toContain(`"${name.replaceAll('"', '""')}"`)
      expect(source).toContain('existing-a')
      expect(source).toContain('existing-b')
      expect(f.definitions).toEqual(before)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('previews exactly one create and commits without changing either existing definition', async () => {
    const f = await fixture()
    const backend = new JsonStorageBackend(join(f.home, 'storages'))
    const facility = new DomainFacility(f.ctx, { backend: 'json' })
    let store: SeatStore | undefined
    try {
      await f.ctx.plugin(StorageService)
      f.ctx.storage.backend.register('json', backend)
      store = await SeatStore.open(facility, join(f.home, 'catalog'))
      const defaults = f.definitions[0]!
      const importer = new SeatImporter(store, { nodeId: 'node-a' as never, nodeAliases: { local: 'node-a' as never },
        defaults, validateOptions: async () => null }, { maxSourceBytes: 65536, maxPlans: 20 })
      const seedPath = join(f.home, 'seed.csv')
      await fs.writeFile(seedPath, 'seat\nexisting-a\nexisting-b\n')
      const seed = await importer.preview({ format: 'csv', sourcePath: seedPath, columnMap: { seat: 'seat' }, defaults: {} })
      await importer.commit({ planId: seed.planId, selectedRows: seed.rows.map(row => row.row),
        expectedRevision: seed.baseRevision, operationId: 'seed-two' as never })
      const before = store.snapshot().definitions
      f.definitions.splice(0, f.definitions.length, ...before)
      const source = await f.ui.prepareAdd({ ...f.request, name: '新增,中文"工位' })
      const plan = await importer.preview(source)
      expect(plan.rows.map(row => row.action)).toEqual(['retain', 'retain', 'create'])
      expect(plan.rows.flatMap(row => row.diagnostics)).toEqual([])
      expect(store.snapshot().definitions).toStrictEqual(before)
      const result = await importer.commit({ planId: plan.planId, expectedRevision: plan.baseRevision,
        selectedRows: plan.rows.filter(row => row.action === 'create').map(row => row.row), operationId: 'add-one' as never })
      expect(result.status).toBe('committed')
      const after = store.snapshot().definitions
      expect(after).toHaveLength(3)
      for (const existing of before) expect(after.find(row => row.seat === existing.seat)).toStrictEqual(existing)
      expect(after.find(row => row.seat === '新增,中文"工位')?.directories).toEqual([{ path: f.cwd, startup: true }])
    } finally {
      await store?.close(); await facility.closeAll(); await backend.close(); await f.ctx.fiber.dispose()
    }
  })
  it('publishes whole CSV snapshots under concurrent preparation without partial temporary files', async () => {
    const f = await fixture()
    try {
      const results = await Promise.all(['one', 'two'].map(name => f.ui.prepareAdd({ ...f.request, name })))
      for (const result of results) expect((await readFile(result.sourcePath, 'utf8')).endsWith('\n')).toBe(true)
      expect((await readdir(join(f.home, 'seats', 'imports'))).some(name => name.endsWith('.tmp'))).toBe(false)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('preserves spaces and Windows backslashes in existing directory cells', async () => {
    const f = await fixture()
    try {
      f.definitions[0]!.directories = [{ path: 'C:\\Work Space\\project', startup: true }]
      const result = await f.ui.prepareAdd(f.request)
      const source = await readFile(result.sourcePath, 'utf8')
      expect(source).toContain('C:\\\\Work Space\\\\project')
      expect(source).toContain('work space')
      expect(f.definitions[0]!.directories[0]!.path).toBe('C:\\Work Space\\project')
    } finally { await f.ctx.fiber.dispose() }
  })
  it('keeps an interrupted publication from exposing a partial CSV and removes its temporary file', async () => {
    const f = await fixture()
    const rename = vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Publication interrupted'))
    try {
      await expect(f.ui.prepareAdd(f.request)).rejects.toThrow('Publication interrupted')
      expect(await readdir(join(f.home, 'seats', 'imports'))).toEqual([])
    } finally { rename.mockReset(); rename.mockImplementation(await vi.importActual<typeof fs>('node:fs/promises').then(actual => actual.rename)); await f.ctx.fiber.dispose() }
  })
  it('refuses an import directory symlink before writing outside home', async () => {
    const f = await fixture()
    try {
      await symlink(f.cwd, join(f.home, 'seats'), 'dir')
      await expect(f.ui.prepareAdd(f.request)).rejects.toThrow('inside home')
      expect(await readdir(f.cwd)).toEqual([])
    } finally { await f.ctx.fiber.dispose() }
  })
  it('rejects a missing directory and an existing name without changing the catalog', async () => {
    const f = await fixture()
    try {
      await expect(f.ui.prepareAdd({ ...f.request, directory: join(f.home, 'absent') })).rejects.toThrow('directory')
      await expect(f.ui.prepareAdd({ ...f.request, name: 'existing-a' })).rejects.toThrow('exists')
    } finally { await f.ctx.fiber.dispose() }
  })
})
