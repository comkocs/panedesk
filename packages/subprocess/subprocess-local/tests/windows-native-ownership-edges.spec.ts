import { describe, expect, it, vi } from 'vitest'
import { createProductJob, enterProductJob, lookupTcpOwner, loadTcpOwnerBindings } from '@panedesk/dsh-win32-process'
import type { NativePtr, TcpOwnerBindings } from '@panedesk/dsh-win32-process'

const native = vi.hoisted(() => ({ load: vi.fn<(name: string) => { func: ReturnType<typeof vi.fn> }>(), pointer: vi.fn(), func: vi.fn() }))
vi.mock('@panedesk/dsh-win32-process/src/koffi.ts', () => ({ requireKoffi: () => native }))
const handle = 123n as NativePtr
const job = 456n as NativePtr
const socket = { remoteAddress: '127.0.0.1', remotePort: 42000, localAddress: '127.0.0.1', localPort: 8080 }

function jobs() {
  return {
    createJobObjectW: vi.fn<() => NativePtr | null>(() => handle),
    openJobObjectW: vi.fn<() => NativePtr | null>(() => job),
    setInformationJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job: NativePtr, _cls: number, buffer: Buffer) => { buffer.writeUInt32LE(0, 40); return 1 }),
    assignProcessToJobObject: vi.fn(() => 1), getCurrentProcess: vi.fn(() => handle),
    closeHandle: vi.fn(() => 1), getLastError: vi.fn(() => 0),
  }
}
function table(): TcpOwnerBindings {
  return {
    getExtendedTcpTable(buffer, size, _order, family) {
      size.writeUInt32LE(family === 2 ? 28 : 4)
      if (buffer === null) return 122
      buffer.writeUInt32LE(family === 2 ? 1 : 0)
      if (family !== 2) return 0
      buffer.writeUInt32LE(5, 4)
      buffer.set([127, 0, 0, 1], 8); buffer.writeUInt16BE(42000, 12)
      buffer.set([127, 0, 0, 1], 16); buffer.writeUInt16BE(8080, 20); buffer.writeUInt32LE(77, 24)
      return 0
    },
    openProcess: () => handle,
    isProcessInJob: (_process, _job, result) => { result.writeUInt32LE(1); return 1 }, closeHandle: () => 1,
  }
}

describe('native Windows ownership refusal observations', () => {
  it('refuses absent Job handles and retries failed handle closure', () => {
    const api = jobs()
    api.createJobObjectW.mockReturnValue(null)
    expect(() => createProductJob(api)).toThrow('CreateJobObjectW failed')
    api.openJobObjectW.mockReturnValue(null)
    expect(() => { enterProductJob('owned', api) }).toThrow('OpenJobObjectW failed')
    api.createJobObjectW.mockReturnValue(handle)
    const owner = createProductJob(api)
    api.closeHandle.mockReturnValueOnce(0).mockReturnValue(1)
    expect(() => { owner.close() }).toThrow('CloseHandle failed')
    owner.close()
    expect(api.closeHandle).toHaveBeenCalledTimes(2)
    api.openJobObjectW.mockReturnValue(job)
    api.closeHandle.mockReturnValue(0)
    expect(() => { enterProductJob('owned', api) }).toThrow('CloseHandle failed for product identity handoff')
  })

  it('loads every native ownership binding without opening a real process', () => {
    native.load.mockReturnValue({ func: native.func })
    native.pointer.mockReturnValue('pointer')
    native.func.mockImplementation((_abi: string, name: string) => {
      if (name === 'CreateJobObjectW' || name === 'OpenJobObjectW' || name === 'GetCurrentProcess') return () => handle
      if (name === 'GetLastError') return () => 0
      return () => 1
    })
    const api = loadTcpOwnerBindings()
    expect(Object.keys(api)).toEqual(['getExtendedTcpTable', 'openProcess', 'isProcessInJob', 'closeHandle'])
    const owner = createProductJob()
    owner.close()
    enterProductJob('owned')
    expect(native.load.mock.calls.map(call => call[0])).toEqual(['kernel32.dll', 'iphlpapi.dll', 'kernel32.dll', 'kernel32.dll'])
    vi.clearAllMocks()
  })

  it('refuses incomplete, malformed, scoped, and mixed-family addresses', () => {
    const api = table()
    for (const key of ['remoteAddress', 'localAddress', 'remotePort', 'localPort'] as const) {
      expect(lookupTcpOwner(api, job, { ...socket, [key]: undefined })).toBe('unknown')
    }
    for (const address of ['invalid', 'fe80::1%eth0', '::1', '::ffff:192.0.2.1']) {
      expect(lookupTcpOwner(api, job, { ...socket, remoteAddress: address })).toBe('unknown')
    }
    expect(lookupTcpOwner(api, job, { ...socket, remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' })).toBe('product-sandbox')
  })

  it.each(['first', 'small', 'second', 'growth', 'count'] as const)('refuses an inconsistent TCP table: %s', (failure) => {
    const api = table()
    const original = api.getExtendedTcpTable.bind(api)
    api.getExtendedTcpTable = (buffer, size, order, family, cls, reserved) => {
      if (failure === 'first') return 0
      const result = original(buffer, size, order, family, cls, reserved)
      if (failure === 'small') size.writeUInt32LE(3)
      if (buffer !== null) {
        if (failure === 'second') return 1
        if (failure === 'growth') size.writeUInt32LE(buffer.length + 1)
        if (failure === 'count') buffer.writeUInt32LE(100)
      }
      return result
    }
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
  })

  it.each(['state', 'local', 'remote', 'remote-port', 'pid', 'duplicate'] as const)('refuses a nonunique or mismatched owner row: %s', (failure) => {
    const api = table()
    const original = api.getExtendedTcpTable.bind(api)
    api.getExtendedTcpTable = (buffer, size, order, family, cls, reserved) => {
      if (failure === 'duplicate' && family === 2 && buffer === null) { size.writeUInt32LE(52); return 122 }
      const result = original(buffer, size, order, family, cls, reserved)
      if (buffer !== null && family === 2) {
        if (failure === 'state') buffer.writeUInt32LE(2, 4)
        if (failure === 'local') buffer[8] = 1
        if (failure === 'remote') buffer[16] = 1
        if (failure === 'remote-port') buffer.writeUInt16BE(9999, 20)
        if (failure === 'pid') buffer.writeUInt32LE(0, 24)
        if (failure === 'duplicate') { buffer.copy(buffer, 28, 4, 28); buffer.writeUInt32LE(2); size.writeUInt32LE(52) }
      }
      return result
    }
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
  })

  it('revalidates ownership while holding the process and refuses cleanup failures', () => {
    const api = table()
    let opened = false
    const original = api.getExtendedTcpTable.bind(api)
    api.openProcess = () => { opened = true; return handle }
    api.getExtendedTcpTable = (buffer, ...args) => {
      const result = original(buffer, ...args)
      if (opened && buffer !== null && args[2] === 2) buffer.writeUInt32LE(78, 24)
      return result
    }
    expect(lookupTcpOwner(api, [], socket)).toBe('unknown')
    api.getExtendedTcpTable = original
    api.closeHandle = () => 0
    expect(lookupTcpOwner(api, [job], socket)).toBe('unknown')
  })

  it.each(['0:0:0:0:0:0:0:1', '2001:db8::1', '::'])(
    'parses an uncompressed, prefixed, or empty IPv6 address without IPv4 fallback: %s', (address) => {
      const api = table()
      expect(lookupTcpOwner(api, job, { ...socket, remoteAddress: address, localAddress: address })).toBe('unknown')
    },
  )
})
