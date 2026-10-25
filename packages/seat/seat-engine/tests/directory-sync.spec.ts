/** Directory-handle tolerance never suppresses file, close or non-Windows failures. */
import { expect, it, vi } from 'vitest'
import { syncDirectory } from '../src/journal.ts'

it.each(['EPERM', 'EISDIR', 'EINVAL'])('tolerates unsupported Windows directory open and sync: %s', async (code) => {
  const error = Object.assign(new Error('Directory unsupported'), { code })
  await expect(syncDirectory('directory', 'win32', async () => { throw error })).resolves.toBeUndefined()
  const close = vi.fn(async () => {})
  await expect(syncDirectory('directory', 'win32', async () => ({ sync: async () => { throw error }, close }))).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledOnce()
})
it.each(['linux', 'darwin', 'win32'] as const)('propagates other open, sync and close errors on %s', async (platform) => {
  const error = Object.assign(new Error('Storage failed'), { code: 'EIO' })
  await expect(syncDirectory('directory', platform, async () => { throw error })).rejects.toBe(error)
  const close = vi.fn(async () => {})
  await expect(syncDirectory('directory', platform, async () => ({ sync: async () => { throw error }, close }))).rejects.toBe(error)
  expect(close).toHaveBeenCalledOnce()
  const denied = Object.assign(new Error('Close failed'), { code: 'EPERM' })
  await expect(syncDirectory('directory', platform, async () => ({ sync: async () => {}, close: async () => { throw denied } }))).rejects.toBe(denied)
})
it.each(['EPERM', 'EISDIR', 'EINVAL'])('preserves unsupported-directory errors on non-Windows: %s', async (code) => {
  const error = Object.assign(new Error('Directory failed'), { code })
  for (const platform of ['linux', 'darwin'] as const) {
    await expect(syncDirectory('directory', platform, async () => { throw error })).rejects.toBe(error)
    await expect(syncDirectory('directory', platform, async () => ({ sync: async () => { throw error }, close: async () => {} }))).rejects.toBe(error)
  }
})
it('synchronizes and closes supported directory handles', async () => {
  const calls: string[] = []
  await syncDirectory('directory', 'win32', async () => ({ sync: async () => { calls.push('sync') }, close: async () => { calls.push('close') } }))
  expect(calls).toEqual(['sync', 'close'])
})
