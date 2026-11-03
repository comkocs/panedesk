/** Native file access decisions use an impersonation copy of the actual restricted token. */
import { allocPtrSlot, allocUint32, decodePtr, decodeUint32, encodeUint32, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { withSecurityHandle } from './file-handle.ts'

/**
 * Check one file right without changing the token or the object's descriptor.
 * @param api Native Windows security bindings.
 * @param token Restricted primary token selected for the sandbox process.
 * @param path Existing file or directory whose security descriptor is checked.
 * @param desired Specific file access mask, without generic bits.
 * @param noFollow Inspect a reparse point itself during workspace inventory.
 * @returns The AccessCheck decision; API failures throw rather than imply denial.
 */
export function checkFileAccess(api: Win32Bindings, token: NativePtr, path: string, desired: number, noFollow = false): boolean {
  const tokenSlot = allocPtrSlot()
  if (api.duplicateToken(token, 2, tokenSlot) === 0) throwLastError(api, 'DuplicateToken', path)
  const impersonation = decodePtr(tokenSlot)
  if (impersonation === null) throw new Error('DuplicateToken returned no impersonation token')
  try {
    const owner = allocPtrSlot()
    const group = allocPtrSlot()
    const dacl = allocPtrSlot()
    const sacl = allocPtrSlot()
    const output = allocPtrSlot()
    try {
      const operation = noFollow ? 'GetSecurityInfo' : 'GetNamedSecurityInfoW'
      const result = noFollow
        ? withSecurityHandle(api, path, false, handle => api.getSecurityInfo(handle, 1, 7, owner, group, dacl, sacl, output))
        : api.getNamedSecurityInfoW(path, 1, 7, owner, group, dacl, sacl, output)
      if (result !== 0) throwWin32(api, operation, result, path)
      const descriptor = decodePtr(output)
      if (descriptor === null) throw new Error(`${operation} returned no security descriptor`)
      const mapping = Buffer.alloc(16)
      ;[0x120089, 0x120116, 0x1200a0, 0x1f01ff].forEach((mask, index) => mapping.writeUInt32LE(mask, index * 4))
      const length = allocUint32()
      const granted = allocUint32()
      const status = allocUint32()
      let privileges = Buffer.alloc(256)
      encodeUint32(length, privileges.length)
      let checked = api.accessCheck(descriptor, impersonation, desired, mapping, privileges, length, granted, status)
      if (checked === 0 && api.getLastError() === 122) {
        const required = decodeUint32(length)
        if (required <= privileges.length) throw new Error('AccessCheck returned an invalid privilege buffer length')
        privileges = Buffer.alloc(required)
        checked = api.accessCheck(descriptor, impersonation, desired, mapping, privileges, length, granted, status)
      }
      if (checked === 0) throwLastError(api, 'AccessCheck', path)
      return decodeUint32(status) !== 0 && (decodeUint32(granted) & desired) === desired
    } finally {
      const descriptor = decodePtr(output)
      if (descriptor !== null && !isNullPtr(api.localFree(descriptor))) throwLastError(api, 'LocalFree', `AccessCheck descriptor: ${path}`)
    }
  } finally {
    if (api.closeHandle(impersonation) === 0) throwLastError(api, 'CloseHandle', 'AccessCheck impersonation token')
  }
}
