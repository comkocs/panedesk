/** Notification directory tolerance never weakens synchronous file durability. */
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { NotificationStore, syncDirectory } from '../src/notification-store.ts'
import type { NotificationRecord } from '../src/notification-store.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
})

it.each(['EPERM', 'EISDIR', 'EINVAL'])('tolerates unsupported Windows notification directory open and sync: %s', (code) => {
  const error = Object.assign(new Error('Directory unsupported'), { code })
  expect(() => {syncDirectory('directory', 'win32', () => { throw error }) }).not.toThrow()
  const close = vi.fn()
  expect(() => {syncDirectory('directory', 'win32', () => 1, () => { throw error }, close) }).not.toThrow()
  expect(close).toHaveBeenCalledExactlyOnceWith(1)
  for (const platform of ['linux', 'darwin'] as const) {
    expect(() => {syncDirectory('directory', platform, () => { throw error }) }).toThrow(error)
    expect(() => {syncDirectory('directory', platform, () => 1, () => { throw error }, () => {}) }).toThrow(error)
  }
})
it.each(['linux', 'darwin', 'win32'] as const)('propagates other notification directory and close errors on %s', (platform) => {
  const error = Object.assign(new Error('Storage failed'), { code: 'EIO' })
  expect(() => {syncDirectory('directory', platform, () => { throw error }) }).toThrow(error)
  const close = vi.fn()
  expect(() => {syncDirectory('directory', platform, () => 1, () => { throw error }, close) }).toThrow(error)
  expect(close).toHaveBeenCalledExactlyOnceWith(1)
  for (const code of ['EPERM', 'EISDIR', 'EINVAL']) {
    const denied = Object.assign(new Error('Close failed'), { code })
    expect(() => {syncDirectory('directory', platform, () => 1, () => {}, () => { throw denied }) }).toThrow(denied)
  }
})
it('synchronizes and closes supported notification directory handles in order', () => {
  const calls: string[] = []
  syncDirectory('directory', 'win32', (path, flags) => {
    expect([path, flags]).toEqual(['directory', 'r'])
    return 1
  }, () => { calls.push('sync') }, () => { calls.push('close') })
  expect(calls).toEqual(['sync', 'close'])
})

const record: NotificationRecord = { version: 1, id: 'job-a', owner: null, phase: 'settled', outcome: 'completed',
  text: 'Done', delivered: false, observedAt: '2026-01-01T00:00:00Z' }
function storage(): NotificationStore {
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
  vi.spyOn(fs, 'readdirSync').mockReturnValue([])
  vi.spyOn(fs, 'openSync').mockReturnValue(1)
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
  vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)
  vi.spyOn(fs, 'closeSync').mockReturnValue(undefined)
  return new NotificationStore('directory', 4096)
}
it.each(['EPERM', 'EISDIR', 'EINVAL'])('never tolerates notification file sync errors on either platform: %s', (code) => {
  const error = Object.assign(new Error('File sync failed'), { code })
  for (const platform of ['linux', 'win32'] as const) {
    Object.defineProperty(process, 'platform', { value: platform })
    const store = storage()
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw error })
    let failure: unknown
    try { store.put(record) } catch (cause) { failure = cause }
    expect(failure).toMatchObject({ code: 'unavailable', cause: error })
    expect(store.records.size).toBe(0)
    expect(fs.closeSync).toHaveBeenCalledWith(1)
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(() => {store.put(record) }).toThrow('requires recovery')
    vi.restoreAllMocks()
  }
})
it('fences notification reads after a renamed record has an uncertain directory sync', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const store = storage()
  vi.spyOn(fs, 'fsyncSync').mockReturnValue(undefined)
  store.put(record)
  const error = Object.assign(new Error('Directory sync failed'), { code: 'EIO' })
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw error })
  expect(() => { store.put({ ...record, delivered: true }) }).toThrow('requires recovery')
  expect(fs.renameSync).toHaveBeenCalledTimes(2)
  expect(store.records.get(record.id)?.delivered).toBe(false)
  expect(() => { store.requireHealthy() }).toThrow('requires recovery')
})

it.each(['EPERM', 'EISDIR', 'EINVAL'])('commits notification state after unsupported Windows directory sync: %s', (code) => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const store = storage()
  const error = Object.assign(new Error('Directory unsupported'), { code })
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {}).mockImplementation(() => { throw error })
  store.put(record)
  expect(store.records.get(record.id)).toEqual(record)
  expect(fs.closeSync).toHaveBeenCalledTimes(2)
})
