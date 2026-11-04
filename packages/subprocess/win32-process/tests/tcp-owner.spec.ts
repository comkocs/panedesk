import { describe, expect, it, vi } from 'vitest'
import { lookupTcpOwner } from '../src/tcp-owner.ts'
import type { TcpOwnerBindings } from '../src/tcp-owner.ts'
import type { NativePtr } from '../src/ffi.ts'

const handle = 123n as NativePtr
const job = 456n as NativePtr
const socket = { remoteAddress: '127.0.0.1', remotePort: 42000, localAddress: '127.0.0.1', localPort: 8080 }

function fixture(member = true) {
  const api: TcpOwnerBindings = {
    getExtendedTcpTable: vi.fn<TcpOwnerBindings['getExtendedTcpTable']>((buffer, size, _order, family) => {
      if (family !== 2) { size.writeUInt32LE(4); if (buffer !== null) buffer.writeUInt32LE(0); return buffer === null ? 122 : 0 }
      size.writeUInt32LE(28)
      if (buffer === null) return 122
      buffer.writeUInt32LE(1)
      buffer.writeUInt32LE(5, 4)
      buffer.set([127, 0, 0, 1], 8)
      buffer.writeUInt16BE(42000, 12)
      buffer.set([127, 0, 0, 1], 16)
      buffer.writeUInt16BE(8080, 20)
      buffer.writeUInt32LE(77, 24)
      return 0
    }),
    openProcess: vi.fn(() => handle),
    isProcessInJob: vi.fn<TcpOwnerBindings['isProcessInJob']>((_process, _job, result) => { result.writeUInt32LE(Number(member)); return 1 }),
    closeHandle: vi.fn(() => 1),
  }
  return api
}

describe('Windows TCP product Job ownership', () => {
  it.each(['inherited', 'piped', 'double-fork descendant'])('identifies a %s member without inspecting its token', () => {
    const api = fixture()
    expect(lookupTcpOwner(api, job, socket)).toBe('product-sandbox')
    expect(api.openProcess).toHaveBeenCalledWith(0x1000, 0, 77)
    expect(api.isProcessInJob).toHaveBeenCalledWith(handle, job, expect.any(Buffer))
    expect(api.closeHandle).toHaveBeenCalledWith(handle)
  })
  it.each(['Edge LPAC Low', 'Chrome AppContainer Medium', 'Firefox restricted Low'])('permits the external %s process', () => {
    expect(lookupTcpOwner(fixture(false), job, socket)).toBe('non-product')
  })
  it('refuses absent rows and missing physical facts', () => {
    expect(lookupTcpOwner(fixture(), job, { ...socket, remotePort: 42001 })).toBe('unknown')
    expect(lookupTcpOwner(fixture(), job, undefined)).toBe('unknown')
  })
  it('refuses an inaccessible process or failed membership call', () => {
    const api = fixture()
    api.openProcess = () => null
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
    api.openProcess = () => handle
    api.isProcessInJob = () => 0
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
  })
  it('matches IPv6 client direction', () => {
    const api = fixture()
    api.getExtendedTcpTable = (buffer, size, _order, family) => {
      const length = family === 23 ? 60 : 4
      size.writeUInt32LE(length)
      if (buffer === null) return 122
      buffer.writeUInt32LE(family === 23 ? 1 : 0)
      if (family === 23) {
        buffer[19] = 1
        buffer.writeUInt16BE(42000, 24)
        buffer[43] = 1
        buffer.writeUInt16BE(8080, 48)
        buffer.writeUInt32LE(5, 52)
        buffer.writeUInt32LE(77, 56)
      }
      return 0
    }
    expect(lookupTcpOwner(api, job, { ...socket, remoteAddress: '::1', localAddress: '::1' })).toBe('product-sandbox')
  })
  it('bounds table allocation and fails closed on native exceptions', () => {
    const api = fixture()
    api.getExtendedTcpTable = (_buffer, size) => { size.writeUInt32LE(0xffffffff); return 122 }
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
    api.getExtendedTcpTable = () => { throw new Error('native failure') }
    expect(lookupTcpOwner(api, job, socket)).toBe('unknown')
  })
})
