/** Virtual Node filesystems without directory descriptors retain path-based operations. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { FsTargetKey } from '@panedesk/dsh-fs'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const { O_DIRECTORY: _directoryFlag, ...constants } = original.constants
  return { ...original, constants }
})

it('probes, lists and publishes through paths in the explicitly identified Worker', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux', title: 'dsh-webworker' })
  const { openDirectory, openDirectoryTarget, usesDirectoryHandles } = await import('../src/directory-handle.ts')
  const { listDirectory, probe, writeFileAtomic } = await import('../src/fsio.ts')
  const root = await mkdtemp(join(tmpdir(), 'virtual-directory-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'workspace')
  await mkdir(directory)
  const file = join(directory, 'skill.txt')
  await writeFile(file, 'original')
  expect(usesDirectoryHandles).toBe(false)
  const opened = await openDirectory(directory)
  try {
    expect(opened.path).toBe(directory)
  } finally {
    await opened.close()
  }
  const target = await openDirectoryTarget(file)
  try {
    expect(target.path).toBe(file)
  } finally {
    await target.close()
  }
  expect((await probe(directory))?.type).toBe('directory')
  expect((await listDirectory({ displayPath: directory, targetKey: FsTargetKey(directory) }))
    .map(entry => [entry.name, entry.type])).toEqual([['skill.txt', 'file']])
  await writeFileAtomic(file, 'updated', 0o600, undefined)
  expect(await readFile(file, 'utf8')).toBe('updated')
})

it('refuses a non-Worker Linux host without O_DIRECTORY before filesystem operations', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux', title: 'node' })
  const { FsError } = await import('@panedesk/dsh-fs')
  const failure = import('../src/directory-handle.ts')
  await expect(failure).rejects.toBeInstanceOf(FsError)
  await expect(failure).rejects.toHaveProperty('code', 'FS_IO_ERROR')
  await expect(failure).rejects.toThrow('Linux filesystem requires O_DIRECTORY; refusing to fall back to path-based operations. Use a runtime with directory-handle support.')
})
