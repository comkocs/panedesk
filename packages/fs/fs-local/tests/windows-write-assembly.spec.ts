import { afterEach, expect, it, vi } from 'vitest'
import { WindowsDirectoryBackend } from '../src/directory-win32.ts'
import { loadWindowsWriteModule } from '../src/win32-write-loader.ts'
import type { OwnedStage } from '../src/directory-handle.ts'
import type { WindowsWriteModule } from '../src/win32-handle-types.ts'
import { metadata, RecordedExecutor } from './fixtures/windows-directory-api.ts'

vi.mock('../src/win32-write-loader.ts', () => ({ loadWindowsWriteModule: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('assembles a write module using retained tokens and explicit self entries', async () => {
  const events: string[] = []
  const stage: OwnedStage = {
    file: { inspect: async () => metadata('identity'), read: async () => 0,
      write: async (_buffer, _offset, length) => length, flush: async () => {}, close: async () => {} },
    prepareMetadata: async () => {}, publish: async () => ({ committed: true, metadata: null }),
    discard: async () => {}, close: async () => { events.push('close-stage') },
  }
  const factory = vi.fn<WindowsWriteModule['createWindowsWriteExtension']>(target => ({
    createDirectory: async () => ({ kind: 'opened', token: 42, metadata: metadata('identity', true) }),
    stage: async (parent, name) => { events.push(`${parent}:${name}:${target.entry.kind}`); return stage },
    readForEdit: async () => ({ content: '', lineEndings: 'LF' }), readTextForDiff: async () => null,
    write: async () => { events.push('write') }, remove: async () => { events.push('remove') },
  }))
  vi.mocked(loadWindowsWriteModule).mockResolvedValue({ createWindowsWriteExtension: factory,
    createWindowsWriteHandler: () => ({ execute: () => ({ kind: 'completed' }), close() {} }) })
  const executor = new RecordedExecutor()
  const backend = new WindowsDirectoryBackend(() => executor)
  await backend.assertWritable()
  const root = await backend.openTarget('C:\\safe', false, { kind: 'authorized-directory', displayPath: 'C:\\safe' })
  const owned = await root.stage('file', { kind: 'new', inheritFromDestination: true })
  await root.close()
  expect(executor.closed).toBe(0)
  await owned.close()
  expect(events).toEqual(['2:file:self', 'close-stage'])
  expect(executor.closed).toBe(1)
  expect(factory).toHaveBeenCalledTimes(1)
})

it('never creates descendants before the authorized root has opened', async () => {
  vi.mocked(loadWindowsWriteModule).mockResolvedValue({
    createWindowsWriteExtension: () => { throw new Error('Unused factory') },
    createWindowsWriteHandler: () => { throw new Error('Unused handler') },
  })
  const executor = new RecordedExecutor((request) => {
    if (request.kind === 'open' && request.name === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  const backend = new WindowsDirectoryBackend(() => executor)
  await expect(backend.openTarget('C:\\missing\\child\\file', true,
    { kind: 'authorized-directory', displayPath: 'C:\\missing' })).rejects.toThrow('missing')
  expect(executor.requests.filter(request => request.kind === 'create-directory')).toEqual([])
  expect(executor.closed).toBe(1)
})
