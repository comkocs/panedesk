/** Worker-local mutation bindings; replacement files inherit permissions in their destination directory. */
import { win32 } from 'node:path'
import koffi from 'koffi'
import { FsError } from '@panedesk/dsh-fs'
import { checkWindowsComponent, refuseWindowsWrite } from './directory-win32.ts'
import { checkReplacementSecurity, createWindowsSecurityBindings } from './win32-write-security.ts'
import { parseSecurityDescriptor } from './win32-security-descriptor.ts'
import { createReplacementMetadataApi } from './win32-metadata-abi.ts'
import { captureReplacementMetadata } from './win32-replacement-metadata.ts'
import type { HandleMetadata, HandleReply, WindowsNativeContext } from './win32-handle-types.ts'
import type { PathInfo } from './directory-legacy.ts'

/** Security descriptors must be constructed for the actual caller and destination, never a default DACL. */
export interface StageSecurity {
  directory: Buffer
  file: Buffer
}

/** Captured security and metadata retain their source until the transaction settles. */
export interface ReplacementPreparation {
  prepare(file: number): void
  close(): void
}

/** Synchronous operations execute on the worker that owns the context's handle table. */
export interface WindowsWriteApi {
  security(parent: number): StageSecurity
  /** Capture the old object before staging; close releases it without mutation. */
  prepareReplacement(parent: number, name: string, observed: PathInfo): ReplacementPreparation
  createDirectory(parent: number, name: string, exclusive: boolean, descriptor: Buffer | null): Extract<HandleReply, { kind: 'opened' }>
  createFile(parent: number, name: string, descriptor: Buffer | null): number
  secureEmpty(token: number, descriptor: Buffer): void
  inspect(token: number): HandleMetadata
  read(token: number, position: bigint, length: number): Uint8Array
  write(token: number, bytes: Uint8Array, position: bigint): number
  flush(token: number): void
  link(token: number, parent: number, name: string): void
  /** Requires completed replacement metadata preparation; does not perform that preparation. */
  replace(token: number, parent: number, name: string): void
  disposition(token: number): void
  openRemoval(parent: number, name: string, type: 'file' | 'empty-directory'): number
  close(token: number): void
}

/** Keep native status and Win32 last-error distinct; only name collisions become no-replace refusals.
 * @param domain - Origin of the numeric error.
 * @param code - Unmodified native status or Win32 error.
 * @param syscall - Operation that captured the error on this thread.
 * @returns Structured filesystem failure without path fallback.
 */
export function windowsWriteFailure(domain: 'NTSTATUS' | 'Win32', code: number, syscall: string): FsError {
  const value = code >>> 0
  const collision = domain === 'NTSTATUS' ? value === 0xc0000035 : value === 80 || value === 183
  const permission = domain === 'NTSTATUS' ? value === 0xc0000022 : value === 5
  const reparse = domain === 'NTSTATUS' && (value === 0x8000002d || value === 0xc0000279)
  const missing = domain === 'NTSTATUS' ? value === 0xc0000034 || value === 0xc000003a : value === 2 || value === 3
  return new FsError(`${syscall} failed / 句柄操作失败 (${domain} ${value})`, collision ? 'FS_NOT_OBSERVED'
    : permission ? 'FS_PERMISSION_DENIED' : reparse ? 'FS_SANDBOX_DENIED' : missing ? 'FS_NOT_FOUND' : 'FS_IO_ERROR')
}

/** Bind kernel32, ntdll and process-token query exports on the owning worker.
 * @param context - Existing read owner's validated native handle table.
 * @returns Relative mutation primitives; security() refuses until its separate capability is available.
 */
export function createWindowsWriteApi(context: WindowsNativeContext): WindowsWriteApi {
  if (process.platform !== 'win32' || process.arch !== 'x64') refuseWindowsWrite()
  const securityBindings = createWindowsSecurityBindings()
  const kernel = koffi.load('kernel32.dll')
  const native = koffi.load('ntdll.dll')
  const unicode = koffi.struct({ Length: 'uint16_t', MaximumLength: 'uint16_t', Buffer: 'void *' })
  const attributes = koffi.struct({ Length: 'uint32_t', RootDirectory: 'void *', ObjectName: 'void *', Attributes: 'uint32_t', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' })
  const linkInfo = koffi.struct({ ReplaceIfExists: 'uint8_t', RootDirectory: 'void *', FileNameLength: 'uint32_t', FileName: 'uint16_t' })
  const renameInfo = koffi.struct({ Flags: 'uint32_t', RootDirectory: 'void *', FileNameLength: 'uint32_t', FileName: 'uint16_t' })
  if (koffi.sizeof(unicode) !== 16 || koffi.sizeof(attributes) !== 48 || koffi.offsetof(linkInfo, 'FileName') !== 20
    || koffi.offsetof(renameInfo, 'FileName') !== 20) {
    throw new FsError('Unsupported mutation ABI / 不支持该句柄写入布局', 'FS_IO_ERROR')
  }
  const create = native.func('int32_t __stdcall NtCreateFile(_Out_ void **, uint32_t, void *, void *, const int64_t *, uint32_t, uint32_t, uint32_t, uint32_t, void *, uint32_t)') as (out: [object | null], access: number, attributes: Buffer, iosb: Buffer, size: null, flags: number, share: number, disposition: number, options: number, ea: null, length: number) => number
  const set = native.func('int32_t __stdcall NtSetInformationFile(void *, void *, void *, uint32_t, int32_t)') as (handle: object, iosb: Buffer, data: Buffer, length: number, information: number) => number
  const setSecurity = native.func('int32_t __stdcall NtSetSecurityObject(void *, uint32_t, const void *)') as (handle: object, information: number, descriptor: Buffer) => number
  const wait = native.func('int32_t __stdcall NtWaitForSingleObject(void *, uint8_t, const int64_t *)') as (handle: object, alertable: number, timeout: null) => number
  const seek = kernel.func('int32_t __stdcall SetFilePointerEx(void *, int64_t, void *, uint32_t)') as (handle: object, offset: bigint, result: null, method: number) => number
  const write = kernel.func('int32_t __stdcall WriteFile(void *, const void *, uint32_t, _Out_ uint32_t *, void *)') as (handle: object, buffer: Uint8Array, length: number, count: [number], overlapped: null) => number
  const read = kernel.func('int32_t __stdcall ReadFile(void *, void *, uint32_t, _Out_ uint32_t *, void *)') as (handle: object, buffer: Buffer, length: number, count: [number], overlapped: null) => number
  const flush = kernel.func('int32_t __stdcall FlushFileBuffers(void *)') as (handle: object) => number
  const close = kernel.func('int32_t __stdcall CloseHandle(void *)') as (handle: object) => number
  const lastError = kernel.func('uint32_t __stdcall GetLastError()') as () => number
  const processHandle = kernel.func('void * __stdcall GetCurrentProcess()') as () => object
  const querySecurity = native.func('int32_t __stdcall NtQuerySecurityObject(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)') as
    (handle: object, information: number, buffer: Buffer, length: number, needed: [number]) => number
  const queryDescriptor = (token: number, handle = context.get(token)): Buffer => {
    let buffer = Buffer.alloc(20)
    const needed: [number] = [0]
    // Owner, group, DACL and integrity label; audit information is not requested.
    const information = 0x17
    let status = querySecurity(handle, information, buffer, buffer.length, needed) >>> 0
    if (status === 0xc0000023 && needed[0] >= 20 && needed[0] <= 65536) {
      buffer = Buffer.alloc(needed[0]); status = querySecurity(handle, information, buffer, buffer.length, needed) >>> 0
    }
    if (status !== 0 || needed[0] < 20 || needed[0] > buffer.length) {
      throw new FsError('Windows security query failed / Windows 安全描述符查询失败', 'FS_IO_ERROR')
    }
    const result = buffer.subarray(0, needed[0]); parseSecurityDescriptor(result)
    return result
  }
  let poisoned = false
  const available = () => { if (poisoned) throw new FsError('Native write capability unavailable / 原生写能力不可用', 'FS_IO_ERROR') }
  const winFailure = (syscall: string) => windowsWriteFailure('Win32', lastError(), syscall)
  const complete = (status: number, handle: object, iosb: Buffer, syscall: string,
    failure = (code: number, operation: string) => windowsWriteFailure('NTSTATUS', code, operation)) => {
    if ((status >>> 0) === 0x103) {
      poisoned = true
      // Pending kernel buffers cannot be abandoned. A successful publication still commits.
      let waited: number
      do { waited = wait(handle, 0, null) } while (waited !== 0 || iosb.readUInt32LE(0) === 0x103)
      status = iosb.readUInt32LE(0)
    }
    if (status !== 0) throw failure(status, syscall)
    if (iosb.readUInt32LE(0) !== 0) throw failure(iosb.readUInt32LE(0), `${syscall} IOSB`)
  }
  const inspect = (token: number) => context.inspect(context.get(token))
  const relative = (parent: number, raw: string, access: number, share: number, disposition: number,
    directory: boolean, descriptor: Buffer | null) => {
    available()
    const name = checkWindowsComponent(raw)
    if (inspect(parent).type !== 'directory') throw new FsError('RootDirectory is not a directory', 'FS_NOT_DIRECTORY')
    const text = Buffer.from(`${name}\0`, 'utf16le')
    const string = Buffer.alloc(koffi.sizeof(unicode))
    koffi.encode(string, unicode, { Length: text.length - 2, MaximumLength: text.length, Buffer: text })
    const object = Buffer.alloc(koffi.sizeof(attributes))
    koffi.encode(object, attributes, { Length: object.length, RootDirectory: context.get(parent), ObjectName: string,
      Attributes: 0x1040, SecurityDescriptor: descriptor, SecurityQualityOfService: null })
    const out: [object | null] = [null]
    const iosb = Buffer.alloc(16)
    const status = create(out, access, object, iosb, null, 0, share, disposition, 0x200020 | (directory ? 1 : 0x40), null, 0)
    const failure = (code: number, operation = 'NtCreateFile') => (code >>> 0) === 0xc0000043
      ? new FsError(`File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试: ${win32.join(inspect(parent).identity.path, name)}`, 'FS_PERMISSION_DENIED', { cause: windowsWriteFailure('NTSTATUS', code, 'NtCreateFile') })
      : windowsWriteFailure('NTSTATUS', code, operation)
    const handle = out[0]
    if (handle === null) throw failure(status || 0xc0000001)
    try {
      complete(status, handle, iosb, 'NtCreateFile', failure)
      available()
    } catch (error) {
      if (!close(handle)) throw new AggregateError([error, winFailure('CloseHandle')], 'Open and cleanup failed')
      throw error
    }
    const owned = context.adopt(handle)
    if ((owned.metadata.type === 'directory') !== directory) {
      context.release(owned.token)
      throw new FsError('Unexpected opened object type', 'FS_IO_ERROR')
    }
    return owned
  }
  const range = (position: bigint, length: number) => {
    if (position < 0n || position > 0x7fffffffffffffffn || !Number.isSafeInteger(length) || length < 0
      || length > 1024 * 1024 || position + BigInt(length) > 0x7fffffffffffffffn) throw new FsError('Invalid native I/O range', 'FS_IO_ERROR')
  }
  return {
    security(_parent) { return refuseWindowsWrite() },
    prepareReplacement(parent, name, observed) {
      // READ_CONTROL plus ordinary reads; ACCESS_SYSTEM_SECURITY is not requested.
      const old = relative(parent, name, 0x120089, 5, 1, false, null).token
      try {
        if (inspect(old).version !== observed.version) throw new FsError('Replacement target changed / 覆盖目标已变化', 'FS_STALE_VERSION')
        const prepare = captureReplacementMetadata(createReplacementMetadataApi(context), old)
        checkReplacementSecurity({ bindings: securityBindings, process: processHandle,
          close(handle) { if (!close(handle)) throw winFailure('CloseHandle') }, query: queryDescriptor }, old)
        return { prepare, close() { context.release(old) } }
      } catch (error) {
        try { context.release(old) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Replacement preparation and cleanup failed') }
        throw error
      }
    },
    createDirectory(parent, name, exclusive, descriptor) {
      if (exclusive && !descriptor) refuseWindowsWrite()
      return relative(parent, name, exclusive ? 0x110087 : 0x100087, exclusive ? 0 : 3, exclusive ? 2 : 3, true, descriptor)
    },
    createFile(parent, name, descriptor) { return relative(parent, name, descriptor ? 0x17019f : 0x13019f, 0, 2, false, descriptor).token },
    secureEmpty(token, descriptor) {
      available()
      if (inspect(token).size !== 0) throw new FsError('Security must precede content', 'FS_IO_ERROR')
      const status = setSecurity(context.get(token), 0x80000004, descriptor)
      if (status !== 0) throw windowsWriteFailure('NTSTATUS', status, 'NtSetSecurityObject')
    },
    inspect,
    read(token, position, length) {
      available(); range(position, length)
      const handle = context.get(token)
      if (!seek(handle, position, null, 0)) throw winFailure('SetFilePointerEx')
      const buffer = Buffer.alloc(length); const count: [number] = [0]
      if (!read(handle, buffer, length, count, null)) throw winFailure('ReadFile')
      if (count[0] > length) throw new FsError('Native read exceeds allocation', 'FS_IO_ERROR')
      return buffer.subarray(0, count[0])
    },
    write(token, bytes, position) {
      available(); range(position, bytes.length)
      const handle = context.get(token)
      if (!seek(handle, position, null, 0)) throw winFailure('SetFilePointerEx')
      const count: [number] = [0]
      if (!write(handle, bytes, bytes.length, count, null)) throw winFailure('WriteFile')
      if (count[0] > bytes.length || (bytes.length > 0 && count[0] === 0)) throw new FsError('Native write made invalid progress', 'FS_IO_ERROR')
      return count[0]
    },
    flush(token) { available(); if (!flush(context.get(token))) throw winFailure('FlushFileBuffers') },
    link(token, parent, raw) {
      available()
      const name = Buffer.from(checkWindowsComponent(raw), 'utf16le')
      if (inspect(parent).type !== 'directory') throw new FsError('Publication parent is not a directory', 'FS_NOT_DIRECTORY')
      const buffer = Buffer.alloc(Math.max(koffi.sizeof(linkInfo), 20 + name.length))
      koffi.encode(buffer, linkInfo, { ReplaceIfExists: 0, RootDirectory: context.get(parent), FileNameLength: name.length, FileName: 0 })
      name.copy(buffer, 20)
      const iosb = Buffer.alloc(16)
      const handle = context.get(token)
      complete(set(handle, iosb, buffer, buffer.length, 11), handle, iosb, 'NtSetInformationFile(FileLinkInformation)')
    },
    replace(token, parent, raw) {
      available()
      const name = Buffer.from(checkWindowsComponent(raw), 'utf16le')
      if (inspect(parent).type !== 'directory') throw new FsError('Publication parent is not a directory', 'FS_NOT_DIRECTORY')
      const buffer = Buffer.alloc(Math.max(koffi.sizeof(renameInfo), 20 + name.length))
      // FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS; never ignore readonly.
      koffi.encode(buffer, renameInfo, { Flags: 3, RootDirectory: context.get(parent), FileNameLength: name.length, FileName: 0 })
      name.copy(buffer, 20)
      const iosb = Buffer.alloc(16)
      const handle = context.get(token)
      try {
        complete(set(handle, iosb, buffer, buffer.length, 65), handle, iosb, 'NtSetInformationFile(FileRenameInformationEx)')
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_PERMISSION_DENIED') {
          throw new FsError('File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试', 'FS_PERMISSION_DENIED', { cause: error })
        }
        throw error
      }
    },
    disposition(token) {
      const handle = context.get(token); const iosb = Buffer.alloc(16); const buffer = Buffer.from([1])
      complete(set(handle, iosb, buffer, 1, 13), handle, iosb, 'NtSetInformationFile(FileDispositionInformation)')
    },
    openRemoval(parent, name, type) { return relative(parent, name, 0x110080, 7, 1, type === 'empty-directory', null).token },
    close(token) { context.release(token) },
  }
}
