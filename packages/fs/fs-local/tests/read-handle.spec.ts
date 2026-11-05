/** Opened-object checks cover native Linux and the macOS/Windows syscall decision layer. */
import { constants } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FsTargetKey } from '@panedesk/dsh-fs'
import { openReadHandle } from '../src/read-handle.ts'

const roots: string[] = []
const platform = process.platform
const restorePlatform = (): void => { Object.defineProperty(process, 'platform', { value: platform }) }
afterEach(async () => {
  restorePlatform()
  vi.doUnmock('koffi')
  vi.doUnmock('../src/read-handle.ts')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['bytes', 'range', 'stream', 'diff'] as const)('closes the descriptor after a %s read failure', async (form) => {
  const close = vi.fn(() => Promise.resolve())
  const error = Object.assign(new Error('synthetic read failure'), { name: form === 'range' ? 'Error' : 'AbortError', code: 'EIO' })
  vi.doMock('../src/read-handle.ts', () => ({ openReadHandle: () => Promise.resolve({
    identity: { path: '/file', dev: 1n, ino: 1n, size: 4, regular: true },
    read: () => Promise.reject(error), close,
  }) }))
  const io = await import('../src/fsio.ts')
  const target = { displayPath: '/file', targetKey: FsTargetKey('/file') }
  if (form === 'bytes') await expect(io.readWholeBytes(target, undefined, 8)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  else if (form === 'range') await expect(io.readByteWindow(target, { offset: 0, length: 4 })).rejects.toBe(error)
  else if (form === 'stream') {
    await expect(io.streamWholeText(target)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'FS_ABORTED' })
  }
  else expect(await io.readTextForDiff('/file', 8)).toBeNull()
  expect(close).toHaveBeenCalledOnce()
})

it('reads the opened object after its name is replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opened-read-'))
  roots.push(root)
  const path = join(root, 'file')
  await writeFile(path, 'original')
  const handle = await openReadHandle(path)
  try {
    expect(handle.identity.regular).toBe(true)
    expect(handle.identity.ino).not.toBe(0n)
    await rename(path, join(root, 'parked'))
    await writeFile(path, 'replacement')
    const buffer = Buffer.alloc(8)
    expect(await handle.read(buffer, 0, buffer.length, 0)).toBe(8)
    expect(buffer.toString()).toBe('original')
  } finally {
    await handle.close()
  }
})

it('does not follow a final link and reports an ancestor link final name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opened-link-'))
  roots.push(root)
  await mkdir(join(root, 'actual'))
  await writeFile(join(root, 'actual', 'file'), 'text')
  await symlink(join(root, 'actual', 'file'), join(root, 'link'), 'file')
  if (platform === 'win32') {
    const handle = await openReadHandle(join(root, 'link'))
    try { expect(handle.identity.regular).toBe(false) } finally { await handle.close() }
  } else {
    expect(constants.O_NOFOLLOW).not.toBe(0)
    await expect(openReadHandle(join(root, 'link'))).rejects.toMatchObject({ code: 'ELOOP' })
  }
  await symlink(join(root, 'actual'), join(root, 'ancestor'), 'junction')
  const handle = await openReadHandle(join(root, 'ancestor', 'file'))
  try { expect(handle.identity.path).toBe(join(root, 'actual', 'file')) } finally { await handle.close() }
})

it('obtains the macOS final name with F_GETPATH on the opened descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opened-mac-'))
  roots.push(root)
  const path = join(root, 'file')
  await writeFile(path, 'text')
  const getPath = vi.fn((fd: number, command: number, type: string, buffer: Buffer) => {
    expect(fd).toBeGreaterThan(0)
    expect(command).toBe(50)
    expect(type).toBe('void *')
    buffer.write(path)
    return 0
  })
  vi.doMock('koffi', () => ({ default: { load: () => ({ func: () => getPath }) } }))
  const { openReadHandle: isolatedOpen } = await import('../src/read-handle.ts')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const handle = await isolatedOpen(path)
  restorePlatform()
  try {
    expect(handle.identity.path).toBe(path)
    expect(getPath).toHaveBeenCalledOnce()
  } finally { await handle.close() }
})

it.each([0, 0x400, 0x10])('uses one Windows handle and rejects nonregular attributes %s', async (attributes) => {
  const nativeHandle = {}
  const close = vi.fn(() => 1)
  const create = vi.fn((_path: string, access: number, share: number, _security: null, disposition: number, flags: number) => {
    expect([access, share, disposition, flags]).toEqual([0x80000000, 7, 3, 0x00200000])
    return nativeHandle
  })
  const information = vi.fn((handle: object, buffer: Buffer) => {
    expect(handle).toBe(nativeHandle)
    buffer.writeUInt32LE(attributes, 0)
    buffer.writeUInt32LE(17, 28)
    buffer.writeUInt32LE(4, 36)
    buffer.writeUInt32LE(23, 48)
    return 1
  })
  const finalName = (handle: object, buffer: Buffer): number => {
    expect(handle).toBe(nativeHandle)
    const path = '\\\\?\\C:\\workspace\\file'
    buffer.write(path, 'utf16le')
    return path.length
  }
  vi.doMock('koffi', () => ({ default: {
    address: () => 1n,
    load: () => ({ func: (declaration: string) => {
      if (declaration.includes('CreateFileW')) return create
      if (declaration.includes('CloseHandle')) return close
      if (declaration.includes('GetFileInformationByHandle')) return information
      if (declaration.includes('GetFinalPathNameByHandleW')) return finalName
      if (declaration.includes('GetFileType')) return () => 1
      if (declaration.includes('SetFilePointerEx')) return () => 1
      if (declaration.includes('ReadFile')) return (handle: object, buffer: Buffer, _length: number, count: [number]) => {
        expect(handle).toBe(nativeHandle)
        buffer.write('text')
        count[0] = 4
        return 1
      }
      return () => 0
    } }),
  } }))
  const { openReadHandle: isolatedOpen } = await import('../src/read-handle.ts')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const handle = await isolatedOpen('C:\\workspace\\file')
  restorePlatform()
  try {
    expect(handle.identity).toEqual({ path: 'C:\\workspace\\file', dev: 17n, ino: 23n, size: 4, regular: attributes === 0 })
    const buffer = Buffer.alloc(4)
    expect(await handle.read(buffer, 0, 4, 0)).toBe(4)
    expect(buffer.toString()).toBe('text')
  } finally { await handle.close() }
  expect(create).toHaveBeenCalledOnce()
  expect(information).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledExactlyOnceWith(nativeHandle)
})
