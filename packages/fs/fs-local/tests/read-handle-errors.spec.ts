/** Platform syscall failures retain descriptor ownership and native error classification. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['before inspection', 'after stat', 'stat failure', 'macOS failure', 'unsupported platform'] as const)(
  'closes a POSIX descriptor on %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'read-inspection-'))
    roots.push(root)
    const path = join(root, 'file')
    await writeFile(path, 'text')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const controller = new AbortController()
    const failure = new Error('synthetic stat failure')
    const close = vi.fn<() => Promise<void>>()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs/promises')>()
      return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        close.mockImplementation(() => handle.close())
        return {
          fd: handle.fd,
          close,
          stat: async () => {
            if (scenario === 'stat failure') throw failure
            const info = await handle.stat({ bigint: true })
            if (scenario === 'after stat') controller.abort()
            return info
          },
        }
      } }
    })
    if (scenario === 'before inspection') controller.abort()
    if (scenario === 'macOS failure') {
      vi.doMock('koffi', () => ({ default: { load: () => ({ func: () => () => -1 }) } }))
      Object.defineProperty(process, 'platform', { value: 'darwin' })
    }
    if (scenario === 'unsupported platform') Object.defineProperty(process, 'platform', { value: 'freebsd' })
    const { openReadHandle } = await import('../src/read-handle.ts')
    if (scenario === 'stat failure') await expect(openReadHandle(path, controller.signal)).rejects.toBe(failure)
    else await expect(openReadHandle(path, controller.signal)).rejects.toMatchObject({
      code: scenario === 'before inspection' || scenario === 'after stat' ? 'FS_ABORTED' : 'FS_IO_ERROR',
    })
    expect(close).toHaveBeenCalledOnce()
  },
)

const windowsScenarios = [
  { name: 'null handle', error: 2, code: 'ENOENT' },
  { name: 'invalid handle', error: 3, code: 'ENOENT' },
  { name: 'information failure', error: 5, code: 'EACCES' },
  { name: 'empty final name', error: 6, code: 'EIO' },
  { name: 'oversized final name', error: 6, code: 'EIO' },
  { name: 'seek failure', error: 6, code: 'EIO' },
  { name: 'read failure', error: 6, code: 'EIO' },
  { name: 'close failure', error: 6, code: 'EIO' },
  { name: 'non-disk handle', error: 0, code: '' },
  { name: 'UNC final name', error: 0, code: '' },
] as const

it.each(windowsScenarios)('retains Windows handle semantics for $name', async (scenario) => {
  const nativeHandle = {}
  const close = vi.fn(() => scenario.name === 'close failure' ? 0 : 1)
  const create = vi.fn(() => scenario.name === 'null handle' ? null : nativeHandle)
  const rawPath = scenario.name === 'UNC final name' ? '\\\\?\\UNC\\server\\share\\file' : '\\\\?\\C:\\workspace\\file'
  const seek = vi.fn(() => scenario.name === 'seek failure' ? 0 : 1)
  const read = vi.fn((handle: object, buffer: Buffer, length: number, count: [number]) => {
    expect(handle).toBe(nativeHandle)
    expect(length).toBe(4)
    if (scenario.name === 'read failure') return 0
    buffer.write('text')
    count[0] = 4
    return 1
  })
  vi.doMock('koffi', () => ({ default: {
    address: () => scenario.name === 'invalid handle' ? 0xffffffffffffffffn : 1n,
    load: () => ({ func: (declaration: string) => {
      if (declaration.includes('CreateFileW')) return create
      if (declaration.includes('CloseHandle')) return close
      if (declaration.includes('GetLastError')) return () => scenario.error
      if (declaration.includes('GetFileInformationByHandle')) return (handle: object, info: Buffer) => {
        expect(handle).toBe(nativeHandle)
        info.writeUInt32LE(17, 28)
        info.writeUInt32LE(1, 32)
        info.writeUInt32LE(4, 36)
        info.writeUInt32LE(2, 44)
        info.writeUInt32LE(23, 48)
        return scenario.name === 'information failure' ? 0 : 1
      }
      if (declaration.includes('GetFinalPathNameByHandleW')) return (handle: object, buffer: Buffer, capacity: number) => {
        expect(handle).toBe(nativeHandle)
        if (scenario.name === 'empty final name') return 0
        if (scenario.name === 'oversized final name') return capacity
        buffer.write(rawPath, 'utf16le')
        return rawPath.length
      }
      if (declaration.includes('GetFileType')) return () => scenario.name === 'non-disk handle' ? 2 : 1
      if (declaration.includes('SetFilePointerEx')) return seek
      if (declaration.includes('ReadFile')) return read
      throw new Error(`Unexpected native declaration: ${declaration}`)
    } }),
  } }))
  const { openReadHandle } = await import('../src/read-handle.ts')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  if (['null handle', 'invalid handle', 'information failure', 'empty final name', 'oversized final name'].includes(scenario.name)) {
    await expect(openReadHandle('C:\\workspace\\file')).rejects.toMatchObject({ code: scenario.code })
    expect(close).toHaveBeenCalledTimes(scenario.name === 'null handle' || scenario.name === 'invalid handle' ? 0 : 1)
    return
  }
  const handle = await openReadHandle('C:\\workspace\\file')
  expect(handle.identity).toEqual({
    path: scenario.name === 'UNC final name' ? '\\\\server\\share\\file' : 'C:\\workspace\\file',
    dev: 17n, ino: (2n << 32n) | 23n, size: 0x100000004, regular: scenario.name !== 'non-disk handle',
  })
  try {
    const buffer = Buffer.alloc(8, '.')
    if (scenario.name === 'seek failure' || scenario.name === 'read failure') {
      expect(() => handle.read(buffer, 2, 4, 7)).toThrow(expect.objectContaining({ code: scenario.code }))
      expect(read).toHaveBeenCalledTimes(scenario.name === 'seek failure' ? 0 : 1)
    } else {
      expect(await handle.read(buffer, 2, 4, 7)).toBe(4)
      expect(buffer.toString()).toBe('..text..')
    }
    expect(seek).toHaveBeenCalledWith(nativeHandle, 7, null, 0)
  } finally {
    if (scenario.name === 'close failure') expect(() => handle.close()).toThrow(expect.objectContaining({ code: scenario.code }))
    else await handle.close()
  }
  expect(close).toHaveBeenCalledExactlyOnceWith(nativeHandle)
})
