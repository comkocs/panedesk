import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { renderOpening } from '../src/template.ts'
import { SeatDirectoryAccess } from '../src/directories.ts'
import type { SessionId } from '@panedesk/dsh-session'

it.skipIf(process.platform === 'win32')('imports drive and UNC seats through Loader and refuses foreign or incompatible openings before effects', async () => {
  const f = await admissionHost()
  try {
    expect(await f.seats.setAuthority({ authority: 'import-source', authorizationRef: 'user-a' as T.AuthorizationRef,
      expectedRevision: 2, operationId: operation('import-authority') })).toMatchObject({ status: 'saved' })
    const sourcePath = join(f.options.directory, 'source.csv')
    const rows = [
      ['seat-b', 'node-b', 'C:\\work\\seat-b'],
      ['seat-c', 'node-b', '\\\\host-a\\share-a\\seat-c'],
      ['seat-d', 'node-a', 'C:/work/seat-d'],
    ]
    const csv = (value: string) => `"${value.replaceAll('"', '""')}"`
    await writeFile(sourcePath, ['seat,node,directories', ...rows.map(([seat, node, path]) =>
      [seat!, node!, JSON.stringify([{ path, startup: true }])].map(csv).join(','))].join('\n'))
    const preview = await f.seats.previewImport({ sourcePath, format: 'csv',
      columnMap: { seat: 'seat', node: 'node', directories: 'directories' }, defaults: {} })
    if ('status' in preview) throw new Error('Preview was rejected')
    expect(preview.rows.map(row => [row.action, row.diagnostics])).toEqual([
      ['create', []], ['create', []], ['create', []],
    ])
    expect(await f.seats.commitImport({ planId: preview.planId, selectedRows: preview.rows.map(row => row.row),
      expectedRevision: 3, operationId: operation('import-paths') })).toMatchObject({ status: 'committed' })
    const seats = await f.reload()
    const saved = await seats.definitions({})
    expect(saved.definitions.slice(1).map(item => item.directories[0]?.path)).toEqual(rows.map(row => row[2]))
    const access = new SeatDirectoryAccess(f.ctx.fs, async () => ({ seat: 'seat-d' as T.SeatName,
      definitions: saved.definitions, policy: { mode: 'read-only', workspaceRoot: f.options.directory }, admitWrite: async () => null }))
    const directoryRequest = { sessionId: 'session-a' as SessionId, rootId: 'root-a' as T.SeatDirectoryRoot['rootId'],
      relativePath: 'memo.txt', maxBytes: 100, content: 'Blocked', operationId: operation('write-path') }
    expect(await access.roots(directoryRequest.sessionId)).toEqual([])
    expect(await access.read(directoryRequest)).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition' } })
    expect(await access.write(directoryRequest)).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition' } })
    const sequence = f.engine.journal.projection.sequence
    for (const [seat, node] of rows) {
      const result = await seats.open({ seat: seat as T.SeatName, origin: 'manual', operationId: operation(`open-${seat}`) })
      expect(result).toMatchObject({ status: 'rejected', error: {
        code: node === 'node-a' ? 'invalid-definition' : 'cross-node-unsupported', effectState: 'none',
      } })
    }
    const incompatible = saved.definitions.find(item => item.seat === 'seat-d')!
    expect(await f.engine.openWindow({ request: { seat: incompatible.seat, origin: 'manual', operationId: operation('direct-open') },
      authority: f.authority, definition: incompatible, title: 'seat-d 01-01',
      opening: renderOpening('Open seat-d', { seat: incompatible.seat, date: '2026-01-01', taskId: null }, 100),
    })).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition', effectState: 'none' } })
    expect(f.engine.journal.projection.sequence).toBe(sequence)
    expect(await f.ctx.sessionPersistence.list()).toEqual([])
    expect(f.engine.journal.projection.resources.size).toBe(0)
    expect(await seats.resolveDirectoryChoice({ cwd: f.options.directory, interactive: false })).toMatchObject({
      status: 'choice-required', candidates: ['seat-a'],
    })
  } finally { await f.close() }
})
