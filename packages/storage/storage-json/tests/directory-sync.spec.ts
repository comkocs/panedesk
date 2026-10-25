/** The existing Windows directory skip never suppresses file synchronization failures. */
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../src/atomic.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})
async function target(): Promise<string> {
  const root = await fs.mkdtemp(join(import.meta.dirname, '.directory-sync-'))
  roots.push(root)
  return join(root, 'record.json')
}
it.each(['EPERM', 'EISDIR', 'EINVAL'])('skips unsupported Windows directory open and sync while POSIX propagates: %s', async (code) => {
  const error = Object.assign(new Error('Directory unsupported'), { code })
  const open = fs.open
  for (const phase of ['open', 'sync'] as const) {
    const directories = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'r') {
        directories()
        if (phase === 'open') throw error
      }
      const handle = await open(...args)
      if (args[1] === 'r') vi.spyOn(handle, 'sync').mockRejectedValue(error)
      return handle
    })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await expect(writeAtomic(await target(), '{}')).resolves.toBeUndefined()
    expect(directories).not.toHaveBeenCalled()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await expect(writeAtomic(await target(), '{}')).rejects.toBe(error)
    expect(directories).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
  }
})
it.each(['EPERM', 'EISDIR', 'EINVAL'])('never suppresses file sync failures on either platform: %s', async (code) => {
  const error = Object.assign(new Error('File sync failed'), { code })
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValue(error)
    return handle
  })
  for (const platform of ['linux', 'win32'] as const) {
    Object.defineProperty(process, 'platform', { value: platform })
    const path = await target()
    await expect(writeAtomic(path, '{}')).rejects.toBe(error)
    await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})
