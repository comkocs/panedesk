/** Handle-only metadata bindings; unavailable enterprise detection prevents native replacement. */
import { constants } from 'node:buffer'
import koffi from 'koffi'
import { FsError } from '@panedesk/dsh-fs'
import type { BackupStream, ReplacementMetadataApi } from './win32-replacement-metadata.ts'
import type { WindowsNativeContext } from './win32-handle-types.ts'

/** Bind independent metadata queries without treating unsupported protection as absent.
 * @param context - Worker-owned native handle table.
 * @returns Metadata operations; enterprise protection detection currently refuses every query.
 */
export function createReplacementMetadataApi(context: WindowsNativeContext): ReplacementMetadataApi {
  const kernel = koffi.load('kernel32.dll')
  const native = koffi.load('ntdll.dll')
  const information = kernel.func('int32_t __stdcall GetFileInformationByHandleEx(void *, int32_t, void *, uint32_t)') as
    (handle: object, information: number, buffer: Buffer, length: number) => number
  const set = native.func('int32_t __stdcall NtSetInformationFile(void *, void *, void *, uint32_t, int32_t)') as
    (handle: object, iosb: Buffer, buffer: Buffer, length: number, information: number) => number
  const security = native.func('int32_t __stdcall NtQuerySecurityObject(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)') as
    (handle: object, information: number, buffer: Buffer, length: number, needed: [number]) => number
  const control = kernel.func('int32_t __stdcall DeviceIoControl(void *, uint32_t, void *, uint32_t, void *, uint32_t, _Out_ uint32_t *, void *)') as
    (handle: object, code: number, input: Buffer | null, inputLength: number,
      output: Buffer | null, outputLength: number, count: [number], overlapped: null) => number
  const backupRead = kernel.func('int32_t __stdcall BackupRead(void *, void *, uint32_t, _Out_ uint32_t *, int32_t, int32_t, _Inout_ void **)') as
    (handle: object, buffer: Buffer | null, length: number, count: [number], abort: number,
      security: number, state: [object | null]) => number
  const backupWrite = kernel.func('int32_t __stdcall BackupWrite(void *, const void *, uint32_t, _Out_ uint32_t *, int32_t, int32_t, _Inout_ void **)') as typeof backupRead
  const wait = native.func('int32_t __stdcall NtWaitForSingleObject(void *, uint8_t, const int64_t *)') as
    (handle: object, alertable: number, timeout: null) => number
  const lastError = kernel.func('uint32_t __stdcall GetLastError()') as () => number
  const failure = (operation: string): FsError => new FsError(`${operation} failed / 元数据调用失败 (Win32 ${lastError()})`, 'FS_IO_ERROR')
  const transfer = (token: number, output: boolean, operation: (io: (bytes: Buffer, eof?: boolean) => boolean) => void): void => {
    const state: [object | null] = [null]
    const handle = context.get(token)
    const fn = output ? backupWrite : backupRead
    let primary: unknown
    try {
      operation((bytes, eof = false) => {
        let offset = 0
        while (offset < bytes.length) {
          const count: [number] = [0]
          const part = bytes.subarray(offset, offset + Math.min(65536, bytes.length - offset))
          if (!fn(handle, part, part.length, count, 0, 0, state)) throw failure(output ? 'BackupWrite' : 'BackupRead')
          if (eof && offset === 0 && count[0] === 0) return false
          if (count[0] === 0 || count[0] > part.length) throw new FsError('Incomplete backup stream / 备份流不完整', 'FS_IO_ERROR')
          offset += count[0]
        }
        return true
      })
    } catch (error) { primary = error; throw error } finally {
      if (state[0] !== null && !fn(handle, null, 0, [0], 1, 0, state)) {
        const cleanup = failure('Backup abort')
        if (primary) throw new AggregateError([primary, cleanup], 'Backup transfer and cleanup failed')
        throw cleanup
      }
    }
  }
  return {
    basic(token) {
      const buffer = Buffer.alloc(40)
      if (!information(context.get(token), 0, buffer, buffer.length)) throw failure('GetFileInformationByHandleEx')
      return buffer
    },
    resourceAttributes(token) {
      let buffer = Buffer.alloc(20)
      const needed: [number] = [0]
      let status = security(context.get(token), 0x20, buffer, buffer.length, needed) >>> 0
      if (status === 0xc0000023 && needed[0] >= 20) {
        buffer = Buffer.alloc(needed[0]); status = security(context.get(token), 0x20, buffer, buffer.length, needed) >>> 0
      }
      if (status !== 0 || needed[0] < 20 || needed[0] > buffer.length || buffer[0] !== 1 || !(buffer.readUInt16LE(2) & 0x8000)) {
        throw new FsError('Resource attribute detection failed / 安全资源属性检测失败', 'FS_IO_ERROR')
      }
      const sacl = buffer.readUInt32LE(12)
      if (!sacl) return false
      if (sacl < 20 || sacl + 8 > needed[0]) throw new FsError('Invalid resource attributes / 安全资源属性无效', 'FS_IO_ERROR')
      const size = buffer.readUInt16LE(sacl + 2)
      if (size < 8 || sacl + size > needed[0]) throw new FsError('Invalid resource attributes / 安全资源属性无效', 'FS_IO_ERROR')
      let offset = sacl + 8
      let found = false
      for (let index = 0; index < buffer.readUInt16LE(sacl + 4); index++) {
        if (offset + 4 > sacl + size) throw new FsError('Invalid resource attributes / 安全资源属性无效', 'FS_IO_ERROR')
        const aceSize = buffer.readUInt16LE(offset + 2)
        if (aceSize < 4 || offset + aceSize > sacl + size) throw new FsError('Invalid resource attributes / 安全资源属性无效', 'FS_IO_ERROR')
        if (buffer[offset] === 0x12) found = true
        else throw new FsError('Unknown resource attribute ACE / 未知安全资源属性 ACE', 'FS_IO_ERROR')
        offset += aceSize
      }
      return found
    },
    enterpriseProtected() {
      throw new FsError('Windows enterprise protection detection unavailable / Windows 企业保护检测不可用', 'FS_IO_ERROR')
    },
    compression(token) {
      const buffer = Buffer.alloc(2); const count: [number] = [0]
      if (!control(context.get(token), 0x9003c, null, 0, buffer, 2, count, null)) throw failure('FSCTL_GET_COMPRESSION')
      if (count[0] !== 2) throw new FsError('Invalid compression result / 压缩格式结果无效', 'FS_IO_ERROR')
      return buffer.readUInt16LE()
    },
    setCompression(token, format) {
      const input = Buffer.alloc(2); input.writeUInt16LE(format)
      if (!control(context.get(token), 0x9c040, input, 2, null, 0, [0], null)) throw failure('FSCTL_SET_COMPRESSION')
    },
    setBasic(token, buffer) {
      const iosb = Buffer.alloc(16)
      const status = set(context.get(token), iosb, buffer, buffer.length, 4) >>> 0
      // A pending kernel call owns the buffer until it settles, even though this preparation is refused.
      if (status === 0x103) {
        let waited: number
        do { waited = wait(context.get(token), 0, null) } while (waited !== 0 || iosb.readUInt32LE(0) === 0x103)
        throw new FsError('Unexpected pending metadata operation / 元数据操作意外挂起', 'FS_IO_ERROR')
      }
      if (status !== 0 || iosb.readUInt32LE(0) !== 0) throw new FsError(`Basic metadata failed / 基本元数据设置失败 (NTSTATUS ${status})`, 'FS_IO_ERROR')
    },
    streams(token) {
      const streams: BackupStream[] = []
      transfer(token, false, (io) => {
        for (;;) {
          const header = Buffer.alloc(20)
          if (!io(header, true)) break
          const id = header.readUInt32LE(0); const attributes = header.readUInt32LE(4)
          const size = header.readBigInt64LE(8); const nameLength = header.readUInt32LE(16)
          if (![1, 2, 3, 4, 7].includes(id) || size < 0n || size > BigInt(constants.MAX_LENGTH)
            || nameLength % 2 !== 0 || nameLength > 65534) throw new FsError('Unknown backup stream / 未知备份流', 'FS_IO_ERROR')
          const name = Buffer.alloc(nameLength); io(name)
          if (id === 4) {
            const data = Buffer.alloc(Number(size)); io(data)
            streams.push({ id, attributes, name: name.toString('utf16le'), data })
          } else {
            let remaining = size
            while (remaining > 0n) {
              const part = Buffer.alloc(Number(remaining > 65536n ? 65536n : remaining)); io(part); remaining -= BigInt(part.length)
            }
          }
        }
      })
      return streams
    },
    writeStream(token, stream) {
      const name = Buffer.from(stream.name, 'utf16le')
      const header = Buffer.alloc(20)
      header.writeUInt32LE(4); header.writeUInt32LE(stream.attributes, 4)
      header.writeBigInt64LE(BigInt(stream.data.length), 8); header.writeUInt32LE(name.length, 16)
      transfer(token, true, (io) => { io(header); io(name); io(stream.data) })
    },
  }
}
