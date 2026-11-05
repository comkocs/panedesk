/** Open-descriptor names must identify the same VFS object as descriptor reads. */
import { Buffer } from 'buffer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import * as fs from '../../src/node/builtin_modules/implemented/fs.ts'
import * as fsp from '../../src/node/builtin_modules/implemented/fs/promises.ts'

let vfs: MemoryVfs
const descriptors: number[] = []

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync('/workspace/dir', { recursive: true })
  vfs.writeFileSync('/workspace/dir/file', 'original')
})

afterEach(() => {
  for (const fd of descriptors.splice(0)) fs.closeSync(fd)
})

it('reports the canonical opened name through the promise builtin', async () => {
  const handle = await fsp.open('/workspace/dir/../dir/file', fs.constants.O_NOFOLLOW)
  try {
    expect(await fsp.readlink(`/proc/self/fd/${handle.fd}`)).toBe('/workspace/dir/file')
    const info = vfs.statSync('/workspace/dir/file', { bigint: true })
    expect(await handle.stat({ bigint: true })).toMatchObject({ dev: 1n, ino: info.ino, size: info.size })
  } finally {
    await handle.close()
  }
})

it('tracks file and ancestor rename without reading a replacement', async () => {
  const handle = await fsp.open('/workspace/dir/file')
  try {
    vfs.renameSync('/workspace/dir/file', '/workspace/dir/moved')
    vfs.writeFileSync('/workspace/dir/file', 'replacement')
    expect(await fsp.readlink(`/proc/self/fd/${handle.fd}`)).toBe('/workspace/dir/moved')
    vfs.renameSync('/workspace/dir', '/workspace/renamed')
    expect(await fsp.readlink(`/proc/self/fd/${handle.fd}`)).toBe('/workspace/renamed/moved')
    expect(await handle.readFile('utf8')).toBe('original')
  } finally {
    await handle.close()
  }
})

it.each(['unlink', 'replacement'] as const)('retains the deleted opened name after %s', async (operation) => {
  const handle = await fsp.open('/workspace/dir/file')
  try {
    if (operation === 'unlink') vfs.unlinkSync('/workspace/dir/file')
    else {
      vfs.writeFileSync('/workspace/new', 'replacement')
      vfs.renameSync('/workspace/new', '/workspace/dir/file')
    }
    expect(await fsp.readlink(`/proc/self/fd/${handle.fd}`)).toBe('/workspace/dir/file (deleted)')
    expect(await handle.readFile('utf8')).toBe('original')
  } finally {
    await handle.close()
  }
})

it('does not substitute another hard link for the opened name', async () => {
  vfs.linkSync('/workspace/dir/file', '/workspace/alias')
  const original = fs.openSync('/workspace/dir/file')
  const alias = fs.openSync('/workspace/alias')
  descriptors.push(original, alias)
  vfs.renameSync('/workspace/alias', '/workspace/moved-alias')
  expect(await fsp.readlink(`/proc/self/fd/${original}`)).toBe('/workspace/dir/file')
  expect(await fsp.readlink(`/proc/self/fd/${alias}`)).toBe('/workspace/moved-alias')
  vfs.unlinkSync('/workspace/dir/file')
  expect(await fsp.readlink(`/proc/self/fd/${original}`)).toBe('/workspace/dir/file (deleted)')
  expect(await fsp.readlink(`/proc/self/fd/${alias}`, 'buffer')).toEqual(Buffer.from('/workspace/moved-alias'))
})

it('releases opened names only after their last descriptor closes', async () => {
  const first = await fsp.open('/workspace/dir/file')
  const second = await fsp.open('/workspace/dir/file')
  try {
    await first.close()
    await first.close()
    vfs.renameSync('/workspace/dir/file', '/workspace/moved')
    expect(await fsp.readlink(`/proc/self/fd/${second.fd}`)).toBe('/workspace/moved')
    expect(vfs).toHaveProperty('openedNames.size', 1)
  } finally {
    await second.close()
  }
  expect(vfs).toHaveProperty('openedNames.size', 0)
  const direct = vfs.open('/workspace/moved')
  await direct.close()
  expect(vfs).toHaveProperty('openedNames.size', 0)
})

it('rejects unknown and closed descriptors and ordinary non-link paths', async () => {
  const handle = await fsp.open('/workspace/dir/file')
  await handle.close()
  for (const path of [`/proc/self/fd/${handle.fd}`, '/proc/self/fd/999999', '/proc/self/fd/-1', '/missing']) {
    await expect(fsp.readlink(path)).rejects.toMatchObject({ code: 'ENOENT', syscall: 'readlink', path })
  }
  await expect(fsp.readlink('/workspace/dir/file')).rejects.toMatchObject({
    code: 'EINVAL', syscall: 'readlink', path: '/workspace/dir/file',
  })
})
