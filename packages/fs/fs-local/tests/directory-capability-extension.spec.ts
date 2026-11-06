import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsDirectoryBackend } from '../src/directory-win32.ts'
import { legacyBackend } from '../src/directory-legacy.ts'
import { openDirectoryTarget } from '../src/directory-handle.ts'
import { RecordedExecutor } from './fixtures/windows-directory-api.ts'

it('walks an existing Windows child through the retained directory', async () => {
  const executor = new RecordedExecutor()
  const root = await new WindowsDirectoryBackend(() => executor).openTarget('C:\\safe', false,
    { kind: 'authorized-directory', displayPath: 'C:\\safe' })
  try {
    expect('walk' in root).toBe(true)
    if (!('walk' in root) || typeof root.walk !== 'function') return
    const child = await root.walk('child', { create: false })
    await child.close()
    expect(executor.requests.filter(request => request.kind === 'root')).toHaveLength(1)
  } finally { await root.close() }
})

it('exposes stage without granting an absent Windows write module', async () => {
  const executor = new RecordedExecutor()
  const root = await new WindowsDirectoryBackend(() => executor).openTarget('C:\\safe', false,
    { kind: 'authorized-directory', displayPath: 'C:\\safe' })
  try {
    expect('stage' in root).toBe(true)
    if (!('stage' in root) || typeof root.stage !== 'function') return
    await expect(root.stage('file', { kind: 'new', inheritFromDestination: true })).rejects.toThrow('not ready')
    expect(executor.requests.some(request => request.kind === 'write')).toBe(false)
  } finally { await root.close() }
})

it('keeps the compatibility name for display rather than descriptor I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'directory-display-'))
  const path = join(directory, 'file')
  await writeFile(path, 'data')
  const target = await openDirectoryTarget(path)
  try { expect(target.path).toBe(path) } finally { await target.close(); await rm(directory, { recursive: true }) }
})

it('walks Linux children without reopening a renamed ancestor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'directory-walk-'))
  await mkdir(join(directory, 'child'))
  const root = await legacyBackend().openTarget(directory, false, { kind: 'authorized-directory', displayPath: directory })
  const moved = `${directory}-moved`
  try {
    await rename(directory, moved)
    await mkdir(directory)
    const child = await root.walk('child', { create: false })
    try { expect((await child.probe())?.type).toBe('directory') } finally { await child.close() }
  } finally {
    await root.close()
    await rm(directory, { recursive: true })
    await rm(moved, { recursive: true })
  }
})

it('refuses independent legacy staging without creating data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'directory-stage-'))
  const root = await legacyBackend().openTarget(directory, false, { kind: 'authorized-directory', displayPath: directory })
  try {
    await expect(root.stage('file', { kind: 'new', inheritFromDestination: true })).rejects.toThrow('not ready')
    await expect(readFile(join(directory, 'file'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await root.close(); await rm(directory, { recursive: true }) }
})
