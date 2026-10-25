/** The existing Windows attachment directory skip never hides file durability errors. */
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { publishImmutableObject } from '../src/store.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
const data = new Uint8Array([1, 2, 3])
const digest = createHash('sha256').update(data).digest('hex')
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})
async function paths(): Promise<{ root: string; target: string }> {
  const home = await fs.mkdtemp(join(import.meta.dirname, '.directory-sync-'))
  roots.push(home)
  const root = join(home, 'attachments', 'v1')
  return { root, target: join(root, 'objects', digest.slice(0, 2), digest) }
}
it.each(['EPERM', 'EISDIR', 'EINVAL'])('skips unsupported Windows attachment directories while POSIX propagates: %s', async (code) => {
  const error = Object.assign(new Error('Directory unsupported'), { code })
  const open = fs.open
  for (const phase of ['open', 'sync'] as const) {
    const directories = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[1] === constants.O_RDONLY) {
        directories()
        if (phase === 'open') throw error
      }
      const handle = await open(...args)
      if (args[1] === constants.O_RDONLY) vi.spyOn(handle, 'sync').mockRejectedValue(error)
      return handle
    })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const windows = await paths()
    await expect(publishImmutableObject(windows.root, windows.target, data, digest)).resolves.toBeUndefined()
    expect(directories).not.toHaveBeenCalled()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const posix = await paths()
    await expect(publishImmutableObject(posix.root, posix.target, data, digest)).rejects.toBe(error)
    expect(directories).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
  }
})
it.each(['EPERM', 'EISDIR', 'EINVAL'])('never suppresses attachment file sync failures on either platform: %s', async (code) => {
  const error = Object.assign(new Error('File sync failed'), { code })
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1] === (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)) vi.spyOn(handle, 'sync').mockRejectedValue(error)
    return handle
  })
  for (const platform of ['linux', 'win32'] as const) {
    Object.defineProperty(process, 'platform', { value: platform })
    const { root, target } = await paths()
    await expect(publishImmutableObject(root, target, data, digest)).rejects.toMatchObject({ cause: error })
    await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})
