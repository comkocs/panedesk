import { describe, expect, it, vi } from 'vitest'
import { lookupTcpOwner } from '../src/tcp-owner.ts'
import type { TcpOwnerBindings } from '../src/tcp-owner.ts'
import type { NativePtr } from '../src/ffi.ts'

const handle = 123n as NativePtr
const job = 456n as NativePtr

function ipv6Table(): TcpOwnerBindings {
  return {
    getExtendedTcpTable: vi.fn<TcpOwnerBindings['getExtendedTcpTable']>((buffer, size, _order, family) => {
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
    }),
    openProcess: vi.fn(() => handle),
    isProcessInJob: vi.fn<TcpOwnerBindings['isProcessInJob']>((_process, _job, result) => { result.writeUInt32LE(1); return 1 }),
    closeHandle: vi.fn(() => 1),
  }
}

describe('mixed IPv6 TCP address classification', () => {
  it('refuses a mixed IPv6 address written without compression', () => {
    const api = ipv6Table()
    expect(lookupTcpOwner(api, job, {
      remoteAddress: '0:0:0:0:0:ffff:1.2.3.4',
      remotePort: 42000,
      localAddress: '::1',
      localPort: 8080,
    })).toBe('unknown')
    expect(api.openProcess).not.toHaveBeenCalled()
  })

  it('admits a compressed mixed IPv6 address', () => {
    const api = ipv6Table()
    expect(lookupTcpOwner(api, job, {
      remoteAddress: '::1.2.3.4',
      remotePort: 42000,
      localAddress: '::1',
      localPort: 8080,
    })).toBe('product-sandbox')
  })
})
