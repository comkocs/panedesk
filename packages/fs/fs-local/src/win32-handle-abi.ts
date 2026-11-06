/** Fixed-width Windows read ABI. Native HANDLE values never leave this worker-local owner. */
import koffi from 'koffi'
import { FsError, FsVersion } from '@panedesk/dsh-fs'
import { checkWindowsComponent } from './directory-win32.ts'
import type { HandleMetadata, HandleReply, HandleRequest } from './win32-handle-types.ts'

/** Win32 FILE_INFO_BY_HANDLE_CLASS; not Native FILE_INFORMATION_CLASS. */
export const win32InformationClass = { basic: 0, standard: 1, attributeTag: 9, id: 18 } as const
/** Native FILE_INFORMATION_CLASS used by NtQueryDirectoryFile. */
export const nativeInformationClass = { directory: 1 } as const

/** Construct bindings only inside a supported Windows worker.
 * @returns Synchronous dispatcher owning every successful native open.
 */
export function createNativeHandleApi(): (request: HandleRequest) => HandleReply {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new FsError('Windows handle backend requires Windows x64 / 句柄后端仅支持 Windows x64', 'FS_IO_ERROR')
  }
  const kernel = koffi.load('kernel32.dll')
  const native = koffi.load('ntdll.dll')
  const unicode = koffi.struct({ Length: 'uint16_t', MaximumLength: 'uint16_t', Buffer: 'void *' })
  const attributes = koffi.struct({ Length: 'uint32_t', RootDirectory: 'void *', ObjectName: 'void *', Attributes: 'uint32_t', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' })
  if (koffi.sizeof(unicode) !== 16 || koffi.offsetof(unicode, 'Buffer') !== 8
    || koffi.sizeof(attributes) !== 48 || koffi.offsetof(attributes, 'RootDirectory') !== 8) {
    throw new FsError('Unsupported Windows ABI layout', 'FS_IO_ERROR')
  }
  const create = kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)') as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: null) => object | null
  const ntCreate = native.func('int32_t __stdcall NtCreateFile(_Out_ void **, uint32_t, void *, void *, const int64_t *, uint32_t, uint32_t, uint32_t, uint32_t, void *, uint32_t)') as (out: [object | null], access: number, attributes: Buffer, iosb: Buffer, size: null, fileAttributes: number, share: number, disposition: number, options: number, ea: null, eaLength: number) => number
  const query = native.func('int32_t __stdcall NtQueryDirectoryFile(void *, void *, void *, void *, void *, void *, uint32_t, int32_t, uint8_t, void *, uint8_t)') as (handle: object, event: null, apc: null, context: null, iosb: Buffer, buffer: Buffer, length: number, information: number, single: number, name: null, restart: number) => number
  const wait = native.func('int32_t __stdcall NtWaitForSingleObject(void *, uint8_t, const int64_t *)') as (handle: object, alertable: number, timeout: null) => number
  const close = kernel.func('int32_t __stdcall CloseHandle(void *)') as (handle: object) => number
  const information = kernel.func('int32_t __stdcall GetFileInformationByHandle(void *, void *)') as (handle: object, buffer: Buffer) => number
  const informationEx = kernel.func('int32_t __stdcall GetFileInformationByHandleEx(void *, int32_t, void *, uint32_t)') as (handle: object, type: number, buffer: Buffer, length: number) => number
  const type = kernel.func('uint32_t __stdcall GetFileType(void *)') as (handle: object) => number
  const finalName = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *, void *, uint32_t, uint32_t)') as (handle: object, buffer: Buffer, length: number, flags: number) => number
  const volume = kernel.func('int32_t __stdcall GetVolumeInformationByHandleW(void *, void *, uint32_t, void *, void *, void *, void *, uint32_t)') as (handle: object, name: Buffer, nameLength: number, serial: Buffer, component: Buffer, flags: Buffer, filesystem: Buffer, filesystemLength: number) => number
  const dosDevice = kernel.func('uint32_t __stdcall QueryDosDeviceW(const char16_t *, void *, uint32_t)') as (name: string, buffer: Buffer, length: number) => number
  const seek = kernel.func('int32_t __stdcall SetFilePointerEx(void *, int64_t, void *, uint32_t)') as (handle: object, position: bigint, result: null, method: number) => number
  const read = kernel.func('int32_t __stdcall ReadFile(void *, void *, uint32_t, _Out_ uint32_t *, void *)') as (handle: object, buffer: Buffer, length: number, count: [number], overlapped: null) => number
  const lastError = kernel.func('uint32_t __stdcall GetLastError()') as () => number
  const handles = new Map<number, object>()
  let sequence = 0
  let poisoned = false

  const winFailure = (syscall: string): Error => {
    const code = lastError()
    if (code === 2 || code === 3) return Object.assign(new Error(`${syscall} failed (Win32 ${code})`), { code: 'ENOENT' })
    return new FsError(`${syscall} failed (Win32 ${code})`, code === 5 ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR')
  }
  const ntFailure = (syscall: string, status: number): Error => {
    const code = status >>> 0
    if (code === 0xc0000034 || code === 0xc000003a) return Object.assign(new Error(`${syscall} failed (NTSTATUS ${code})`), { code: 'ENOENT' })
    return new FsError(`${syscall} failed (NTSTATUS ${code})`, code === 0xc0000022 ? 'FS_PERMISSION_DENIED'
      : code === 0x8000002d || code === 0xc0000279 ? 'FS_SANDBOX_DENIED' : 'FS_IO_ERROR')
  }
  const get = (token: number): object => {
    const handle = handles.get(token)
    if (!handle) throw new FsError('Unknown or closed handle token', 'FS_IO_ERROR')
    return handle
  }
  const inspect = (handle: object): HandleMetadata => {
    const tag = Buffer.alloc(8)
    if (!informationEx(handle, win32InformationClass.attributeTag, tag, tag.length)) throw winFailure('GetFileInformationByHandleEx')
    const flags = tag.readUInt32LE(0)
    if (flags & 0x400) throw new FsError('Reparse points are forbidden / 禁止访问重解析点', 'FS_SANDBOX_DENIED')
    if (type(handle) !== 1) throw new FsError('Only disk handles are supported', 'FS_IO_ERROR')
    const info = Buffer.alloc(52)
    if (!information(handle, info)) throw winFailure('GetFileInformationByHandle')
    const basic = Buffer.alloc(40)
    if (!informationEx(handle, win32InformationClass.basic, basic, basic.length)) throw winFailure('GetFileInformationByHandleEx')
    const standard = Buffer.alloc(24)
    if (!informationEx(handle, win32InformationClass.standard, standard, standard.length)) throw winFailure('GetFileInformationByHandleEx')
    const id = Buffer.alloc(24)
    if (!informationEx(handle, win32InformationClass.id, id, id.length)) throw winFailure('GetFileInformationByHandleEx')
    const name = Buffer.alloc(65536)
    const length = finalName(handle, name, name.length / 2, 0)
    if (!length) throw winFailure('GetFinalPathNameByHandleW')
    if (length >= name.length / 2) throw new FsError('Final handle name exceeds supported size', 'FS_IO_ERROR')
    const rawPath = name.subarray(0, length * 2).toString('utf16le')
    const path = rawPath.replace(/^\\\\\?\\/u, '')
    const dev = BigInt(info.readUInt32LE(28))
    const ino = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48))
    const size = standard.readBigInt64LE(8)
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new FsError('File size cannot be represented safely', 'FS_TOO_LARGE')
    if ((id.readBigUInt64LE(0) & 0xffffffffn) !== dev || id.readBigUInt64LE(8) !== ino) {
      throw new FsError('Inconsistent native file identity', 'FS_IO_ERROR')
    }
    const mtime = (basic.readBigInt64LE(16) - 116444736000000000n) * 100n
    const ctime = (basic.readBigInt64LE(24) - 116444736000000000n) * 100n
    const directory = (flags & 0x10) !== 0
    return {
      identity: { path, dev, ino, size: Number(size), regular: !directory },
      version: FsVersion(`${dev}:${ino}:${size}:${mtime}:${ctime}`), mode: flags & 1 ? 0o444 : 0o666,
      type: directory ? 'directory' : 'file', size: Number(size), attributes: flags, reparseTag: tag.readUInt32LE(4),
    }
  }
  const own = (handle: object): HandleReply => {
    const token = ++sequence
    handles.set(token, handle)
    try { return { kind: 'opened', token, metadata: inspect(handle) } } catch (error) {
      handles.delete(token)
      if (!close(handle)) throw new AggregateError([error, winFailure('CloseHandle')], 'Inspection and handle cleanup failed')
      throw error
    }
  }
  const complete = (status: number, handle: object, iosb: Buffer): number => {
    if ((status >>> 0) !== 0x103) return status >>> 0
    // This synchronous caller cannot abandon pending kernel buffers, even if a wait fails.
    // A non-returning kernel operation is not advertised as cancellable or time-bounded.
    poisoned = true
    let waited: number
    do { waited = wait(handle, 0, null) } while (waited !== 0 || iosb.readUInt32LE(0) === 0x103)
    throw new FsError(`Unexpected pending native operation (${iosb.readUInt32LE(0)}); backend disabled`, 'FS_IO_ERROR')
  }

  return (request) => {
    if (poisoned && request.kind !== 'close' && request.kind !== 'shutdown') throw new FsError('Native capability is unavailable', 'FS_IO_ERROR')
    switch (request.kind) {
      case 'root': {
        if (!/^[A-Z]:\\$/u.test(request.path)) throw new FsError('Invalid volume root', 'FS_SANDBOX_DENIED')
        const device = Buffer.alloc(65536)
        if (!dosDevice(request.path.slice(0, 2), device, device.length / 2)) throw winFailure('QueryDosDeviceW')
        const deviceName = device.toString('utf16le').split('\0')[0]
        if (!deviceName || !/^\\Device\\HarddiskVolume[0-9]+$/u.test(deviceName)) throw new FsError('Untrusted drive mapping / 不支持该盘符映射', 'FS_SANDBOX_DENIED')
        const handle = create(request.path, 0x100081, 3, null, 3, 0x02200000, null)
        if (handle === null || koffi.address(handle) === 0xffffffffffffffffn) throw winFailure('CreateFileW')
        try {
          const rootName = Buffer.alloc(65536)
          const rootLength = finalName(handle, rootName, rootName.length / 2, 2)
          if (!rootLength) throw winFailure('GetFinalPathNameByHandleW')
          if (rootLength >= rootName.length / 2 || rootName.subarray(0, rootLength * 2).toString('utf16le') !== `${deviceName}\\`) {
            throw new FsError('Drive mapping changed while opening the volume root', 'FS_SANDBOX_DENIED')
          }
          const fs = Buffer.alloc(64)
          if (!volume(handle, Buffer.alloc(512), 256, Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), fs, 32)) throw winFailure('GetVolumeInformationByHandleW')
          if (fs.toString('utf16le').split('\0')[0] !== 'NTFS') throw new FsError('Only local NTFS volumes are supported', 'FS_IO_ERROR')
        } catch (error) {
          if (!close(handle)) throw new AggregateError([error, winFailure('CloseHandle')], 'Volume inspection cleanup failed')
          throw error
        }
        return own(handle)
      }
      case 'open': {
        checkWindowsComponent(request.name)
        const parent = get(request.parent)
        if (inspect(parent).type !== 'directory') throw new FsError('RootDirectory must be a directory', 'FS_NOT_DIRECTORY')
        const text = Buffer.from(`${request.name}\0`, 'utf16le')
        const name = Buffer.alloc(koffi.sizeof(unicode))
        koffi.encode(name, unicode, { Length: text.length - 2, MaximumLength: text.length, Buffer: text })
        const object = Buffer.alloc(koffi.sizeof(attributes))
        koffi.encode(object, attributes, {
          Length: object.length, RootDirectory: parent, ObjectName: name, Attributes: 0x1040,
          SecurityDescriptor: null, SecurityQualityOfService: null,
        })
        const out: [object | null] = [null]
        const iosb = Buffer.alloc(16)
        const status = ntCreate(out, 0x100080 | (request.directory || request.content ? 1 : 0), object, iosb, null, 0,
          request.directory ? 3 : 7, 1, 0x200020 | (request.directory ? 1 : request.content ? 0x40 : 0), null, 0)
        if ((status >>> 0) === 0x103) {
          if (out[0] === null) throw new FsError('Pending open returned no handle', 'FS_IO_ERROR')
          handles.set(++sequence, out[0])
          complete(status, out[0], iosb)
        }
        if (status !== 0) throw ntFailure('NtCreateFile', status)
        if (out[0] === null) throw new FsError('Native open returned no handle', 'FS_IO_ERROR')
        if (iosb.readUInt32LE(0) !== 0) {
          handles.set(++sequence, out[0])
          throw ntFailure('NtCreateFile IOSB', iosb.readUInt32LE(0))
        }
        return own(out[0])
      }
      case 'inspect': return { kind: 'metadata', metadata: inspect(get(request.token)) }
      case 'read': {
        const handle = get(request.token)
        if (request.position < 0n || request.position > 0x7fffffffffffffffn || !Number.isSafeInteger(request.length)
          || request.length < 0 || request.length > 1024 * 1024) throw new FsError('Unsupported native read range', 'FS_IO_ERROR')
        if (!seek(handle, request.position, null, 0)) throw winFailure('SetFilePointerEx')
        const bytes = Buffer.alloc(request.length)
        const count: [number] = [0]
        if (!read(handle, bytes, bytes.length, count, null)) throw winFailure('ReadFile')
        if (count[0] > bytes.length) throw new FsError('Native read exceeded buffer', 'FS_IO_ERROR')
        return { kind: 'bytes', bytes: bytes.subarray(0, count[0]) }
      }
      case 'enumerate': {
        const handle = get(request.token)
        if (!Number.isSafeInteger(request.size) || request.size < 64 || request.size > 1024 * 1024) throw new FsError('Unsupported directory buffer size', 'FS_IO_ERROR')
        const bytes = Buffer.alloc(request.size)
        const iosb = Buffer.alloc(16)
        const status = complete(query(handle, null, null, null, iosb, bytes, bytes.length,
          nativeInformationClass.directory, 0, null, Number(request.restart)), handle, iosb)
        const size = iosb.readBigUInt64LE(8)
        if (size > BigInt(bytes.length)) throw new FsError('Directory information exceeds allocation', 'FS_IO_ERROR')
        if (status === 0 && iosb.readUInt32LE(0) !== 0) throw ntFailure('NtQueryDirectoryFile IOSB', iosb.readUInt32LE(0))
        return { kind: 'directory', status, bytes: bytes.subarray(0, Number(size)) }
      }
      case 'close': {
        const handle = get(request.token)
        handles.delete(request.token)
        if (!close(handle)) throw winFailure('CloseHandle')
        return { kind: 'closed' }
      }
      case 'shutdown': {
        const errors: Error[] = []
        for (const [token, handle] of [...handles].reverse()) {
          handles.delete(token)
          if (!close(handle)) errors.push(winFailure('CloseHandle'))
        }
        if (errors.length) throw new AggregateError(errors, 'Native handle cleanup failed')
        return { kind: 'closed' }
      }
    }
  }
}
