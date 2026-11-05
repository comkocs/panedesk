/** Virtual Node filesystems without directory descriptors retain path-based operations. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FsTargetKey } from '@panedesk/dsh-fs'
import { openDirectory, openDirectoryTarget, usesDirectoryHandles } from '../src/directory-handle.ts'
import { listDirectory, probe, writeFileAtomic } from '../src/fsio.ts'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const { O_DIRECTORY: _directoryFlag, ...constants } = original.constants
  return { ...original, constants }
})

it('probes, lists and publishes through paths when O_DIRECTORY is unavailable', async () => {
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
