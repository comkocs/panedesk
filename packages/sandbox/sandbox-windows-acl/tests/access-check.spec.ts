/** AccessCheck receives the restricted token, an impersonation copy and file generic mapping. */
import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import { checkFileAccess } from '../src/access-check.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'

const pointer = koffi.pointer('void')
function fixture(allowed: boolean) {
  const token = 42n as NativePtr
  const duplicate = 43n as NativePtr
  const descriptor = 44n as NativePtr
  const calls: string[] = []
  const api: Partial<Win32Bindings> = {
    duplicateToken: vi.fn((source: NativePtr, level: number, slot: NativePtr) => {
      expect(source).toBe(token)
      expect(level).toBe(2)
      koffi.encode(slot, pointer, duplicate)
      calls.push('duplicate')
      return 1
    }),
    getNamedSecurityInfoW: vi.fn((_path, type, information, _owner, _group, _dacl, _sacl, slot) => {
      expect(type).toBe(1)
      expect(information).toBe(7)
      koffi.encode(slot, pointer, descriptor)
      calls.push('descriptor')
      return 0
    }),
    accessCheck: vi.fn<Win32Bindings['accessCheck']>((sd, impersonation, desired, mapping, _privileges, _length, granted, status) => {
      expect(sd).toBe(descriptor)
      expect(impersonation).toBe(duplicate)
      expect(desired).toBe(2)
      expect([...Array.from({ length: 4 }, (_, index) => mapping.readUInt32LE(index * 4))])
        .toEqual([0x120089, 0x120116, 0x1200a0, 0x1f01ff])
      koffi.encode(granted, 'uint32', allowed ? desired : 0)
      koffi.encode(status, 'uint32', allowed ? 1 : 0)
      calls.push('check')
      return 1
    }),
    closeHandle: vi.fn(() => { calls.push('close'); return 1 }),
    localFree: vi.fn(() => { calls.push('free'); return 0n as NativePtr }),
    getLastError: () => 5,
    formatMessageW: () => 0,
  }
  return { api: api as Win32Bindings, token, calls }
}

describe('restricted-token file AccessCheck', () => {
  it.each([true, false])('returns the native decision %s and releases descriptor and token', (allowed) => {
    const f = fixture(allowed)
    expect(checkFileAccess(f.api, f.token, 'C:\\state', 2)).toBe(allowed)
    expect(f.calls).toEqual(['duplicate', 'descriptor', 'check', 'free', 'close'])
  })

  it('fails closed when AccessCheck fails and still releases both resources', () => {
    const f = fixture(false)
    f.api.accessCheck = () => 0
    expect(() => checkFileAccess(f.api, f.token, 'C:\\state', 2)).toThrow('AccessCheck')
    expect(f.calls).toEqual(['duplicate', 'descriptor', 'free', 'close'])
  })

  it('frees a no-follow descriptor even when closing its object handle fails', () => {
    const f = fixture(false)
    const object = 45n as NativePtr
    f.api.createFileW = () => object
    f.api.getSecurityInfo = (_handle, _type, _information, _owner, _group, _dacl, _sacl, slot) => {
      koffi.encode(slot, pointer, 44n as NativePtr)
      return 0
    }
    f.api.closeHandle = (handle) => { f.calls.push('close'); return handle === object ? 0 : 1 }
    expect(() => checkFileAccess(f.api, f.token, 'C:\\state', 2, true)).toThrow('CloseHandle')
    expect(f.calls).toEqual(['duplicate', 'close', 'free', 'close'])
  })

  it('retries an insufficient privilege buffer without accepting an uninitialized decision', () => {
    const f = fixture(true)
    const check = f.api.accessCheck.bind(f.api)
    f.api.getLastError = () => 122
    let first = true
    f.api.accessCheck = (...args) => {
      if (first) {
        first = false
        koffi.encode(args[5], 'uint32', 4096)
        return 0
      }
      expect(args[4].length).toBe(4096)
      return check(...args)
    }
    expect(checkFileAccess(f.api, f.token, 'C:\\state', 2)).toBe(true)
  })
})
