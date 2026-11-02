/** Native ACL calls are replaced while explicit legacy inspection and revocation stay real. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import koffi from 'koffi'
import { AclWriteGrant } from '../src/grant.ts'

const acl = vi.hoisted(() => ({ inspect: vi.fn(() => true), revoke: vi.fn(() => true), grant: vi.fn() }))
vi.mock('../src/acl.ts', () => ({ hasWriteGrant: acl.inspect, revokeWrite: acl.revoke, grantWrite: acl.grant }))
const pointer = koffi.pointer('void')
function bindings(): Win32Bindings {
  const api: Partial<Win32Bindings> = {
    convertStringSidToSidW: (_sid: string, slot: NativePtr) => { koffi.encode(slot, pointer, 42n); return 1 },
    createWellKnownSid: () => 1,
    isValidSid: () => 1,
    localFree: () => 0n as NativePtr,
  }
  return api as Win32Bindings
}

beforeEach(() => { vi.clearAllMocks() })
describe('explicit workspace ACL management', () => {
  it('detects a legacy grant without adding any ACE', () => {
    const grant = AclWriteGrant.create('S-1-4-42-42', bindings())
    try {
      expect(grant.has('C:\\project')).toBe(true)
      expect(acl.inspect).toHaveBeenCalledWith(expect.anything(), 'C:\\project', 42n)
      expect(acl.grant).not.toHaveBeenCalled()
    } finally { grant.dispose() }
  })
  it('revokes a standing grant and permits later materialization', () => {
    const grant = AclWriteGrant.create('S-1-4-42-42', bindings())
    try {
      grant.add('C:\\project', true)
      grant.revoke('C:\\project')
      expect(acl.revoke).toHaveBeenCalledWith(expect.anything(), 'C:\\project', 42n)
      expect(grant.paths).toEqual([])
      grant.add('C:\\project', true)
      expect(acl.grant).toHaveBeenCalledTimes(2)
    } finally { grant.dispose() }
  })
  it('keeps failed revocations available for retry', () => {
    const grant = AclWriteGrant.create('S-1-4-42-42', bindings())
    try {
      grant.add('C:\\project', true)
      acl.revoke.mockImplementationOnce(() => { throw new Error('native revoke failed') })
      expect(() => { grant.revoke('C:\\project') }).toThrow('native revoke failed')
      expect(grant.paths).toEqual(['C:\\project'])
    } finally { grant.dispose() }
  })
})
