import { expect, it } from 'vitest'
import { directoryFixture, RecordedExecutor } from './fixtures/windows-directory-api.ts'
import { WindowsDirectoryBackend, enumerateWindows } from '../src/directory-win32.ts'
import { FsTargetKey } from '@panedesk/dsh-fs'
import { readWholeText, readByteWindow } from '../src/fsio.ts'

it('accumulates short reads and closes all native ownership', async () => {
  const executor = new RecordedExecutor()
  const backend = new WindowsDirectoryBackend(() => executor)
  const target = { targetKey: FsTargetKey('C:\\\\safe\\\\file'), displayPath: 'file', backend }
  expect(await readWholeText(target)).toBe('data')
  expect(executor.closed).toBe(1)
  expect(executor.live.size).toBe(0)
})

it('reads a bounded window and refuses pre-cancelled operations', async () => {
  const executor = new RecordedExecutor()
  const backend = new WindowsDirectoryBackend(() => executor)
  const target = { targetKey: FsTargetKey('C:\\\\safe\\\\file'), displayPath: 'file', backend }
  expect(Buffer.from(await readByteWindow(target, { offset: 1, length: 2 })).toString()).toBe('at')
  const controller = new AbortController()
  controller.abort()
  await expect(readWholeText(target, controller.signal)).rejects.toHaveProperty('code', 'FS_ABORTED')
})

it('bounds repeated empty directory results', async () => {
  const executor = new RecordedExecutor(request => request.kind === 'enumerate'
    ? { kind: 'directory', status: 0, bytes: Buffer.alloc(0) } : undefined)
  await expect(enumerateWindows(executor, 1)).rejects.toThrow('buffer')
  expect(executor.requests.length).toBe(9)
})

it('authorizes the opened identity before the first content read', async () => {
  const fixture = directoryFixture()
  await expect(fixture.readDenied()).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})

it('retries a zero-byte directory buffer without treating it as EOF', async () => {
  const fixture = directoryFixture()
  expect(await fixture.enumerateEmptyBuffer()).toEqual(['file.txt'])
})
