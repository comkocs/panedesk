/** Read-only file probes construct the same write-restricted token as the process backend. */
import { checkFileAccess } from './access-check.ts'
import { describeStateAllowAces, sidText } from './ace-diagnostic.ts'
import type { StateAllowAce } from './ace-diagnostic.ts'
import { allocPtrSlot, decodePtr, freeBytes, isNullPtr, throwLastError, win32Sync } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, restrictTokenIntegrity, setTokenDefaultDaclGrant } from './token.ts'
import * as abi from './win32-abi.ts'

/** A restricted token retained across file checks; construction never changes an ACL. */
export class RestrictedFileAccess {
  private constructor(private readonly api: Win32Bindings, private readonly token: NativePtr,
    private readonly restrictingSids: readonly string[]) {}

  /**
   * Construct the sandbox's token with its exact workspace and optional temporary capabilities.
   * @param writeSids Capability SIDs selected for the process; empty selects read-only.
   * @returns An owned token probe that the caller must dispose.
   */
  static create(writeSids: readonly string[]): RestrictedFileAccess {
    const api = win32Sync()
    const current = openCurrentProcessToken(api)
    const allocations: NativePtr[] = []
    const byteBlocks: NativePtr[] = []
    let token: NativePtr | undefined
    try {
      try {
        const sids = writeSids.map((sid) => {
          const output = allocPtrSlot()
          if (api.convertStringSidToSidW(sid, output) === 0) throwLastError(api, 'ConvertStringSidToSidW', sid)
          const pointer = decodePtr(output)
          if (pointer === null) throw new Error('ConvertStringSidToSidW returned no SID')
          allocations.push(pointer)
          return pointer
        })
        const low = makeWellKnownSid(api, abi.WinLowLabelSid)
        byteBlocks.push(low)
        const world = makeWellKnownSid(api, abi.WinWorldSid)
        byteBlocks.push(world)
        const logon = findLogonSid(api, current)
        byteBlocks.push(logon)
        token = createRestrictedToken(api, current, logon, sids, { world }, sids.length === 0 ? 'read-only' : 'workspace-write')
        restrictTokenIntegrity(api, token, low)
        setTokenDefaultDaclGrant(api, token, sids.at(-1) ?? world)
        return new RestrictedFileAccess(api, token, [sidText(logon), sidText(world), ...writeSids])
      } finally {
        try {
          for (const block of byteBlocks) freeBytes(block)
          let failed = false
          for (const allocation of allocations) {
            if (!isNullPtr(api.localFree(allocation))) failed = true
          }
          if (failed) throw new Error('LocalFree failed for an access probe SID')
        } finally {
          if (api.closeHandle(current) === 0) throwLastError(api, 'CloseHandle', 'access probe source token')
        }
      }
    } catch (error) {
      if (token !== undefined && api.closeHandle(token) === 0) {
        throw new AggregateError([error], 'Access probe failed and its restricted token could not be closed')
      }
      throw error
    }
  }

  /**
   * Check one right using this retained sandbox token.
   * @param path Existing file or directory.
   * @param mask Specific file access mask.
   * @param noFollow Inspect the reparse point rather than its target.
   * @returns The native AccessCheck decision.
   */
  permits(path: string, mask: number, noFollow = false): boolean {
    return checkFileAccess(this.api, this.token, path, mask, noFollow)
  }

  /**
   * Describe matching allow entries only after a native access check has granted a dangerous right.
   * @param path Writable state ancestor.
   * @param mask Granted access bit.
   * @returns Exact trustee and explicit source information for owner remediation.
   */
  describe(path: string, mask: number): readonly StateAllowAce[] {
    return describeStateAllowAces(this.api, path, mask, this.restrictingSids)
  }

  /** Close the restricted token; failures remain visible to the caller. */
  dispose(): void {
    if (isNullPtr(this.token) || this.api.closeHandle(this.token) === 0) throwLastError(this.api, 'CloseHandle', 'access probe token')
  }
}
