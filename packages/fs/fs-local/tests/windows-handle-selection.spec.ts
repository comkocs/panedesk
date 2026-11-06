import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { Context } from '@panedesk/cordis'
import { FsTargetKey } from '@panedesk/dsh-fs'
import { LocalFileSystem } from '../src/index.ts'
import { createDirectoryBackend } from '../src/directory-backend.ts'
import { directoryFixture, RecordedExecutor } from './fixtures/windows-directory-api.ts'
import { WindowsDirectoryBackend } from '../src/directory-win32.ts'
import { createHandleExecutor } from '../src/win32-handle-executor.ts'

vi.mock('../src/win32-handle-executor.ts', () => ({ createHandleExecutor: vi.fn() }))
vi.mock('../src/win32-write-loader.ts', () => ({ loadWindowsWriteModule: async () => null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), stat: vi.fn(original.stat), lstat: vi.fn(original.lstat),
    mkdir: vi.fn(original.mkdir), readdir: vi.fn(original.readdir), rename: vi.fn(original.rename),
    rm: vi.fn(original.rm), realpath: vi.fn(original.realpath) }
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('rejects writes before every path API and does not use mutable platform hooks', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const paths = [vi.mocked(fs.open), vi.mocked(fs.stat), vi.mocked(fs.lstat), vi.mocked(fs.mkdir),
    vi.mocked(fs.readdir), vi.mocked(fs.rename), vi.mocked(fs.rm), vi.mocked(fs.realpath)]
  for (const spy of paths) spy.mockClear()
  vi.mocked(createHandleExecutor).mockImplementation(() => new RecordedExecutor())
  const context = new Context()
  const fiber = await context.plugin(LocalFileSystem, { cwd: 'C:\\\\safe', windowsHandleBackend: 'experimental' })
  try {
    const target = { targetKey: FsTargetKey('C:\\\\safe\\\\file'), displayPath: 'file' }
    const resolved = await context.fs.resolve('file')
    await context.fs.stat(resolved)
    await context.fs.lstat('file')
    expect(await context.fs.readText(target)).toBe('data')
    expect(Buffer.from(await context.fs.readBytes(target, undefined, 8)).toString()).toBe('data')
    expect(Buffer.from(await context.fs.readByteRange(target, { offset: 0, length: 2 })).toString()).toBe('da')
    let streamed = ''
    for await (const chunk of await context.fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('data')
    await context.fs.listDir(await context.fs.resolve('C:\\\\safe'))
    await expect(context.fs.watch(target, () => {}, new AbortController().signal)).rejects.toThrow('尚未就绪')
    await expect(context.fs.writeText(target, 'data')).rejects.toThrow('尚未就绪')
    await expect(context.fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false })).rejects.toThrow('not ready')
    expect(paths.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  } finally { await fiber.dispose() }
})

it('selects a fixed Windows instance and keeps Linux on its existing adapter', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  expect(createDirectoryBackend('disabled').choice).toBe('legacy')
  expect(createDirectoryBackend('experimental').choice).toBe('windows-handles')
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  expect(createDirectoryBackend('experimental').choice).toBe('legacy')
})

it('refuses create and remove without touching path APIs', async () => {
  const executor = new RecordedExecutor()
  const backend = new WindowsDirectoryBackend(() => executor)
  await expect(backend.openTarget('C:\\\\safe\\\\file', true, { kind: 'filesystem' })).rejects.toThrow('not ready')
  expect(executor.requests).toEqual([])
  const target = await backend.openTarget('C:\\\\safe\\\\file', false, { kind: 'filesystem' })
  try { await expect(target.remove()).rejects.toThrow('not ready') } finally { await target.close() }
})

it('never falls back to paths after selecting the handle backend', async () => {
  const fixture = directoryFixture()
  await expect(fixture.failedBackend()).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})

it('keeps the legacy backend selected by default', () => {
  expect(directoryFixture().defaultChoice()).toBe('disabled')
})
