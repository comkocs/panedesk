/** Security operations open a reparse point itself, never its target outside the inventory. */
import { isInvalidHandle, throwLastError } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'

/**
 * Retain an object handle across a descriptor operation without following reparse points.
 * @param api Native file bindings.
 * @param path Existing object to inspect or edit.
 * @param writable Whether WRITE_DAC is required in addition to READ_CONTROL.
 * @param operation Security operation receiving the owned handle.
 * @returns The operation's result; close failures are reported.
 */
export function withSecurityHandle<T>(api: Win32Bindings, path: string, writable: boolean, operation: (handle: NativePtr) => T): T {
  const handle = api.createFileW(path, 0x20000 | (writable ? 0x40000 : 0), 7, null, 3, 0x02200000, null)
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', path)
  try { return operation(handle) } finally {
    if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', path)
  }
}
