/** Product identity is distinct from workspace capabilities and changes no ACL access. */
import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { createRestrictedToken } from '../src/token.ts'

const pointer = koffi.pointer('void')
const marker = 'S-1-4-1346457157-1145393995-1396853070-2'

function capture(mode: 'read-only' | 'workspace-write'): string[] {
  const known = new Map<bigint, string>([[1n, 'logon'], [2n, 'everyone'], [3n, 'workspace']])
  let captured: string[] = []
  const create = vi.fn<Win32Bindings['createRestrictedToken']>((_token, _flags, _disableCount, _disable,
    _privilegeCount, _privileges, count, sids, result) => {
    captured = Array.from({ length: count }, (_, index) => {
      const address = sids.readBigUInt64LE(index * 16)
      const name = known.get(address)
      if (name !== undefined) return name
      const bytes = koffi.decode(address, 'uint8', 24) as number[]
      const sid = Buffer.from(bytes)
      return `S-${sid[0]}-${sid.readUIntBE(2, 6)}-${Array.from({ length: sid[1]! }, (_, part) => sid.readUInt32LE(8 + part * 4)).join('-')}`
    })
    koffi.encode(result, pointer, 9n)
    return 1
  })
  const api = { createRestrictedToken: create } as Pick<Win32Bindings, 'createRestrictedToken'> as Win32Bindings
  createRestrictedToken(api, 8n as NativePtr, 1n as NativePtr,
    mode === 'read-only' ? [] : [3n as NativePtr], { world: 2n as NativePtr }, mode)
  expect(create).toHaveBeenCalledTimes(1)
  return captured
}

describe('product restricted SID', () => {
  it.each(['read-only', 'workspace-write'] as const)('marks %s without changing existing capability SIDs', (mode) => {
    expect(capture(mode)).toEqual(mode === 'read-only'
      ? ['logon', 'everyone', marker]
      : ['logon', 'everyone', 'workspace', marker])
  })

  it.each(['read-only', 'workspace-write'] as const)('is write-neutral for %s ACLs', (mode) => {
    const after = capture(mode)
    const before = mode === 'read-only' ? ['logon', 'everyone'] : ['logon', 'everyone', 'workspace']
    const acls = [[], ['logon'], ['everyone'], ['workspace'], ['other-workspace'], ['authenticated-users']]
    const writeAccess = (sids: readonly string[]): boolean[] => acls.map(acl => acl.some(sid => sids.includes(sid)))
    expect(acls.flat().includes(marker)).toBe(false)
    expect(after.includes(marker)).toBe(true)
    expect(writeAccess(after)).toEqual(writeAccess(before))
    expect(writeAccess(after)).toEqual(mode === 'read-only'
      ? [false, true, true, false, false, false]
      : [false, true, true, true, false, false])
  })
})
