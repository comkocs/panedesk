import { expect, it } from 'vitest'
import { directoryFixture, RecordedExecutor, directoryRecord } from './fixtures/windows-directory-api.ts'
import { checkWindowsComponent, directoryNames, WindowsDirectoryBackend } from '../src/directory-win32.ts'

it.each(['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\0b', 'a.', 'a ', 'CON', 'LPT1.txt', '\ud800'])('rejects unsafe component %j', (name) => {
  expect(() => checkWindowsComponent(name)).toThrow()
})

it('keeps unicode spelling and rejects malformed enumeration bounds', () => {
  expect(checkWindowsComponent('文档.txt')).toBe('文档.txt')
  expect(directoryNames(directoryRecord('文档.txt'))).toEqual(['文档.txt'])
  const record = directoryRecord('file')
  record.writeUInt32LE(3, 60)
  expect(() => directoryNames(record)).toThrow('offsets')
  expect(() => directoryNames(Buffer.alloc(63))).toThrow('Truncated')
})

it('retains ancestors until target close and closes exactly once', async () => {
  const executor = new RecordedExecutor()
  const target = await new WindowsDirectoryBackend(() => executor).openTarget('C:\\safe\\file', false, { kind: 'filesystem' })
  expect(executor.live.size).toBe(2)
  await target.probe()
  expect(executor.live.size).toBe(2)
  await Promise.all([target.close(), target.close()])
  expect(executor.closed).toBe(1)
  expect(executor.live.size).toBe(0)
  await expect(target.probe()).rejects.toThrow('closed')
})

it('rejects every reparse component before opening its child', async () => {
  const fixture = directoryFixture()
  await expect(fixture.walkReparse()).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})

it('retains the authorized root before creating descendants', async () => {
  const fixture = directoryFixture()
  await expect(fixture.createBelowMissingRoot()).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})
