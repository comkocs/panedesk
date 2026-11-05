/** Descriptor-owned reads retain the authorized object across path replacement. */
import { constants } from 'node:fs'
import { open, readlink } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'
import { FsError } from '@panedesk/dsh-fs'

/** Identity and final name obtained from the opened file, before any content read. */
export interface ReadIdentity {
  /** Kernel-reported final name, without resolving the caller's path again. */
  path: string
  /** Device or Windows volume serial number. */
  dev: bigint
  /** Inode or Windows file index on that device. */
  ino: bigint
  /** Opened file size in bytes. */
  size: number
  /** Whether the opened object is a regular file rather than a link or special device. */
  regular: boolean
}

/** An owned descriptor; callers must close it on success, failure, and cancellation. */
export interface ReadHandle {
  /** Metadata obtained before any content read. */
  identity: ReadIdentity
  /**
   * Read from this object without resolving a name.
   * @param buffer - Destination storage.
   * @param offset - Destination byte offset.
   * @param length - Maximum bytes to read.
   * @param position - Absolute file byte offset.
   * @returns Number of bytes read; zero at EOF.
   */
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>
  /** Release the descriptor after its final read has settled. */
  close(): Promise<void>
}

/**
 * Open without following the final component and inspect the same object used for reads.
 * @param path - Previously resolved filename; ancestor replacements are detected by final-name authorization.
 * @param signal - Optional cancellation checked before descriptor inspection.
 * @returns Owned handle with kernel-derived identity; no content has been read.
 */
export async function openReadHandle(path: string, signal?: AbortSignal): Promise<ReadHandle> {
  if (process.platform === 'win32') return openWindowsReadHandle(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const info = await handle.stat({ bigint: true })
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    let finalPath: string
    if (process.platform === 'linux') {
      finalPath = await readlink(`/proc/self/fd/${handle.fd}`)
    } else if (process.platform === 'darwin') {
      const koffi = (await import('koffi')).default
      const libc = koffi.load('/usr/lib/libSystem.B.dylib')
      const getPath = libc.func('int fcntl(int fd, int command, ...)') as (
        fd: number, command: number, type: string, path: Buffer,
      ) => number
      const buffer = Buffer.alloc(1024)
      if (getPath(handle.fd, 50, 'void *', buffer) !== 0) throw new FsError('Cannot inspect opened file', 'FS_IO_ERROR')
      finalPath = buffer.subarray(0, buffer.indexOf(0)).toString()
    } else {
      throw new FsError('Cannot inspect opened file on this platform', 'FS_IO_ERROR')
    }
    return {
      identity: { path: finalPath, dev: info.dev, ino: info.ino, size: Number(info.size), regular: info.isFile() },
      async read(buffer, offset, length, position) {
        return (await handle.read(buffer, offset, length, position)).bytesRead
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function openWindowsReadHandle(path: string): Promise<ReadHandle> {
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  const create = kernel.func('void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)') as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: null) => object | null
  const close = kernel.func('int __stdcall CloseHandle(void *handle)') as (handle: object) => number
  const information = kernel.func('int __stdcall GetFileInformationByHandle(void *handle, void *info)') as (handle: object, info: Buffer) => number
  const fileType = kernel.func('uint32_t __stdcall GetFileType(void *handle)') as (handle: object) => number
  const finalName = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, void *path, uint32_t length, uint32_t flags)') as (handle: object, path: Buffer, length: number, flags: number) => number
  const seek = kernel.func('int __stdcall SetFilePointerEx(void *handle, int64_t distance, void *position, uint32_t method)') as (handle: object, distance: number, position: null, method: number) => number
  const read = kernel.func('int __stdcall ReadFile(void *handle, void *buffer, uint32_t length, _Out_ uint32_t *read, void *overlapped)') as (handle: object, buffer: Buffer, length: number, count: [number], overlapped: null) => number
  const lastError = kernel.func('uint32_t __stdcall GetLastError()') as () => number
  const failure = (): NodeJS.ErrnoException => {
    const error = lastError()
    return Object.assign(new Error(`Opened file operation failed (${error})`), {
      code: error === 2 || error === 3 ? 'ENOENT' : error === 5 ? 'EACCES' : 'EIO',
    })
  }
  // OPEN_REPARSE_POINT inspects a final link itself; sharing permits ordinary atomic replacements.
  const handle = create(toNamespacedPath(path), 0x80000000, 7, null, 3, 0x00200000, null)
  if (handle === null || koffi.address(handle) === 0xffffffffffffffffn) throw failure()
  try {
    const info = Buffer.alloc(52)
    if (!information(handle, info)) throw failure()
    const name = Buffer.alloc(65536)
    const length = finalName(handle, name, name.length / 2, 0)
    if (length === 0 || length >= name.length / 2) throw failure()
    const rawPath = name.subarray(0, length * 2).toString('utf16le')
    const finalPath = rawPath.startsWith('\\\\?\\UNC\\') ? `\\\\${rawPath.slice(8)}` : rawPath.replace(/^\\\\\?\\/u, '')
    const attributes = info.readUInt32LE(0)
    return {
      identity: {
        path: finalPath,
        dev: BigInt(info.readUInt32LE(28)),
        ino: (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)),
        size: info.readUInt32LE(32) * 0x100000000 + info.readUInt32LE(36),
        regular: fileType(handle) === 1 && (attributes & (0x10 | 0x400)) === 0,
      },
      read(buffer, offset, length, position) {
        if (!seek(handle, position, null, 0)) throw failure()
        const count: [number] = [0]
        if (!read(handle, buffer.subarray(offset, offset + length), length, count, null)) throw failure()
        return Promise.resolve(count[0])
      },
      close() {
        if (!close(handle)) throw failure()
        return Promise.resolve()
      },
    }
  } catch (error) {
    close(handle)
    throw error
  }
}
