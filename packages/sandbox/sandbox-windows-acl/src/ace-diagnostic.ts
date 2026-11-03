/** Read-only ACE diagnostics accompany, but never replace, the token's native AccessCheck decision. */
import { dirname } from 'node:path'
import { allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'

/** One allow entry that contributes the denied state's write permission. */
export interface StateAllowAce {
  readonly directory: string
  readonly sid: string
  readonly mask: number
  readonly inherited: boolean
  readonly command: string
}

/**
 * Decode a validated native SID without resolving localized account names.
 * @param sid Native SID pointer.
 * @param offset Inline SID byte offset.
 * @returns Stable SDDL SID spelling.
 */
export function sidText(sid: NativePtr, offset = 0): string {
  const count = decodeUint8At(sid, offset + 1)
  if (count > 15) throw new Error('Invalid SID subauthority count')
  let authority = 0n
  for (let index = 2; index < 8; index++) authority = authority * 256n + BigInt(decodeUint8At(sid, offset + index))
  const subauthorities = Array.from({ length: count }, (_, index) => decodeUint32At(sid, offset + 8 + index * 4))
  return `S-${decodeUint8At(sid, offset)}-${authority}${subauthorities.map(value => `-${value}`).join('')}`
}

/**
 * Locate matching allow ACEs, following inherited entries to an explicit source when available.
 * @param api Native descriptor bindings.
 * @param directory Writable object reported by AccessCheck.
 * @param mask Granted file access bit.
 * @param restrictingSids Exact restricting SID set used to build the sandbox token.
 * @returns Concrete ACEs and PowerShell commands for owner review; no command is executed.
 */
export function describeStateAllowAces(
  api: Win32Bindings, directory: string, mask: number, restrictingSids: readonly string[],
): readonly StateAllowAce[] {
  const result: StateAllowAce[] = []
  const unresolved = new Set(restrictingSids)
  for (let path = directory; ; path = dirname(path)) {
    const owner = allocPtrSlot()
    const group = allocPtrSlot()
    const dacl = allocPtrSlot()
    const sacl = allocPtrSlot()
    const output = allocPtrSlot()
    const read = api.getNamedSecurityInfoW(path, 1, 4, owner, group, dacl, sacl, output)
    if (read !== 0) throwWin32(api, 'GetNamedSecurityInfoW', read, path)
    const descriptor = decodePtr(output)
    const acl = decodePtr(dacl)
    try {
      if (acl !== null) {
        const size = decodeUint16At(acl, 2)
        const count = decodeUint16At(acl, 4)
        let offset = 8
        for (let index = 0; index < count; index++) {
          if (offset + 8 > size) throw new Error('Invalid state DACL')
          const length = decodeUint16At(acl, offset + 2)
          if (length < 8 || offset + length > size) throw new Error('Invalid state ACE')
          const type = decodeUint8At(acl, offset)
          const flags = decodeUint8At(acl, offset + 1)
          const rights = decodeUint32At(acl, offset + 4)
          if (type === 0 && length >= 16 && (rights & mask) !== 0) {
            const count = decodeUint8At(acl, offset + 9)
            if (16 + count * 4 > length) throw new Error('Invalid state ACE SID')
            const sid = sidText(acl, offset + 8)
            if (unresolved.has(sid) && (flags & 0x10) === 0) {
              const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
              result.push({ directory: path, sid, mask: rights, inherited: path !== directory,
                command: `icacls.exe ${quote(path)} /remove:g ${quote(`*${sid}`)}` })
              unresolved.delete(sid)
            }
          }
          offset += length
        }
      }
    } finally {
      if (descriptor !== null && !isNullPtr(api.localFree(descriptor))) throwLastError(api, 'LocalFree', path)
    }
    if (dirname(path) === path || unresolved.size === 0) return result
  }
}
