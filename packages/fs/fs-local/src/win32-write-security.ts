/** Worker-local security synthesis bindings; loading exports does not establish inheritance equivalence. */
import koffi from 'koffi'

/** Raw synchronous ABI: callers own token handles and descriptors, including failure cleanup. */
export interface WindowsSecurityBindings {
  openProcessToken(process: object, access: number, token: [object | null]): number
  getTokenInformation(token: object, information: number, buffer: Buffer | null, length: number, needed: [number]): number
  /** The output is self-relative and must be released with destroyPrivateObjectSecurity. */
  createPrivateObjectSecurityEx(parent: Buffer | null, creator: Buffer | null, descriptor: [object | null],
    objectType: Buffer | null, container: number, flags: number, token: object | null, mapping: Buffer): number
  destroyPrivateObjectSecurity(descriptor: [object | null]): number
}

/** Load only the four security synthesis exports; failures propagate without a path fallback.
 * @returns Synchronous functions for the owning Windows worker; BOOL parameters are 32-bit.
 */
export function createWindowsSecurityBindings(): WindowsSecurityBindings {
  const security = koffi.load('advapi32.dll')
  return {
    openProcessToken: security.func('int32_t __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)') as WindowsSecurityBindings['openProcessToken'],
    getTokenInformation: security.func('int32_t __stdcall GetTokenInformation(void *, int32_t, void *, uint32_t, _Out_ uint32_t *)') as WindowsSecurityBindings['getTokenInformation'],
    createPrivateObjectSecurityEx: security.func('int32_t __stdcall CreatePrivateObjectSecurityEx(void *, void *, _Out_ void **, void *, int32_t, uint32_t, void *, void *)') as WindowsSecurityBindings['createPrivateObjectSecurityEx'],
    destroyPrivateObjectSecurity: security.func('int32_t __stdcall DestroyPrivateObjectSecurity(_Inout_ void **)') as WindowsSecurityBindings['destroyPrivateObjectSecurity'],
  }
}
