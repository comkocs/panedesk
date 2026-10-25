/** Unsupported directory synchronization never masks file durability failures. */
import { afterEach, expect, it, vi, type MockInstance } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { syncDirectory, resolveNodeId } from '../src/journal.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
vi.mock('../src/lock.ts', () => ({
  withWriterLock: async (_path: string, _options: object, action: () => Promise<unknown>) => action(),
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

it.each(['EPERM', 'EISDIR', 'EINVAL'])('tolerates unsupported Windows directory open and sync: %s', async (code) => {
  const error = Object.assign(new Error('Directory unsupported'), { code })
  await expect(syncDirectory('directory', 'win32', async () => { throw error })).resolves.toBeUndefined()
  const close = vi.fn(async () => {})
  await expect(syncDirectory('directory', 'win32', async () => ({ sync: async () => { throw error }, close }))).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledOnce()
  for (const platform of ['linux', 'darwin'] as const) {
    await expect(syncDirectory('directory', platform, async () => { throw error })).rejects.toBe(error)
    await expect(syncDirectory('directory', platform, async () => ({ sync: async () => { throw error }, close: async () => {} }))).rejects.toBe(error)
  }
})
it.each(['linux', 'darwin', 'win32'] as const)('propagates other open, sync and close failures on %s', async (platform) => {
  const error = Object.assign(new Error('Storage failed'), { code: 'EIO' })
  await expect(syncDirectory('directory', platform, async () => { throw error })).rejects.toBe(error)
  const close = vi.fn(async () => {})
  await expect(syncDirectory('directory', platform, async () => ({ sync: async () => { throw error }, close }))).rejects.toBe(error)
  expect(close).toHaveBeenCalledOnce()
  for (const code of ['EPERM', 'EISDIR', 'EINVAL']) {
    const denied = Object.assign(new Error('Close failed'), { code })
    await expect(syncDirectory('directory', platform, async () => ({ sync: async () => {}, close: async () => { throw denied } }))).rejects.toBe(denied)
  }
})
it('synchronizes and closes supported directory handles in order', async () => {
  const calls: string[] = []
  await syncDirectory('directory', 'win32', async (_path, flags) => {
    expect(flags).toBe('r')
    return { sync: async () => { calls.push('sync') }, close: async () => { calls.push('close') } }
  })
  expect(calls).toEqual(['sync', 'close'])
})
it.each(['EPERM', 'EISDIR', 'EINVAL'])('never tolerates file sync errors on either platform: %s', async (code) => {
  const error = Object.assign(new Error('File sync failed'), { code })
  const open = fs.open
  const closes: MockInstance<fs.FileHandle['close']>[] = []
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1] === 'wx') {
      closes.push(vi.spyOn(handle, 'close'))
      vi.spyOn(handle, 'sync').mockRejectedValue(error)
    }
    return handle
  })
  for (const platform of ['linux', 'win32'] as const) {
    const root = await fs.mkdtemp(join(import.meta.dirname, '.directory-sync-'))
    roots.push(root)
    Object.defineProperty(process, 'platform', { value: platform })
    await expect(resolveNodeId(root, { lockTimeoutMs: 100, lockRetryMs: 1 })).rejects.toBe(error)
  }
  expect(closes).toHaveLength(2)
  for (const close of closes) expect(close).toHaveBeenCalledOnce()
})
