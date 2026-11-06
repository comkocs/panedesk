/** Worker-local permission detection never constructs replacement security descriptors. */
import koffi from 'koffi'
import { parseSecurityDescriptor, refuseSecurity, securityAces } from './win32-security-descriptor.ts'

/** Raw synchronous token queries; callers own the returned token handle. */
export interface WindowsSecurityBindings {
  openProcessToken(process: object, access: number, token: [object | null]): number
  getTokenInformation(token: object, information: number, buffer: Buffer | null, length: number, needed: [number]): number
}

/** Load only the token queries needed to check the file owner.
 * @returns Synchronous functions for the owning Windows worker.
 */
export function createWindowsSecurityBindings(): WindowsSecurityBindings {
  const security = koffi.load('advapi32.dll')
  return {
    openProcessToken: security.func('int32_t __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)') as WindowsSecurityBindings['openProcessToken'],
    getTokenInformation: security.func('int32_t __stdcall GetTokenInformation(void *, int32_t, void *, uint32_t, _Out_ uint32_t *)') as WindowsSecurityBindings['getTokenInformation'],
  }
}

/** Worker-owned handle queries and token lifetime operations. */
export interface SecurityPreparationApi {
  bindings: WindowsSecurityBindings
  process(): object
  close(token: object): void
  query(token: number): Buffer
}

/** Admit only inherited permissions whose owner matches the process token's default owner.
 * @param api - Native descriptor and process-token queries, never path operations.
 * @param old - Retained file whose owner, DACL and integrity label must be observable.
 */
export function checkReplacementSecurity(api: SecurityPreparationApi, old: number): void {
  const token: [object | null] = [null]
  let primary: unknown
  try {
    const previous = parseSecurityDescriptor(api.query(old))
    // Protected or absent ACLs cannot establish inheritance from the containing directory.
    if ((previous.control & 0x3000) !== 0 || !(previous.control & 4) || !previous.dacl) refuseSecurity()
    const dacl = securityAces(previous.dacl)
    // Only an explicit integrity label is individually configured; one inherited from the
    // containing directory is admitted, and audit entries are not examined.
    if (dacl.length === 0 || dacl.some(ace => !(ace.readUInt8(1) & 0x10))
      || (previous.sacl && securityAces(previous.sacl).some(ace => ace.readUInt8(0) === 17 && !(ace.readUInt8(1) & 0x10)))) refuseSecurity()
    if (!api.bindings.openProcessToken(api.process(), 8, token) || !token[0]) refuseSecurity()
    // The token's default owner owns the file created without a descriptor, even when its user differs.
    const information = 4
    const needed: [number] = [0]
    if (api.bindings.getTokenInformation(token[0], information, null, 0, needed) || needed[0] < 16 || needed[0] > 65536) refuseSecurity()
    const buffer = Buffer.alloc(needed[0])
    if (!api.bindings.getTokenInformation(token[0], information, buffer, buffer.length, needed)
      || needed[0] < 16 || needed[0] > buffer.length) refuseSecurity()
    const pointer = koffi.decode(buffer, 'void *') as object | null
    if (!pointer) refuseSecurity()
    const address = koffi.address(pointer); const base = koffi.address(buffer)
    if (address < base || address + 8n > base + BigInt(needed[0])) refuseSecurity()
    const offset = Number(address - base); const count = buffer.readUInt8(offset + 1)
    if (buffer[offset] !== 1 || count > 15 || offset + 8 + count * 4 > needed[0]) refuseSecurity()
    if (!previous.owner.equals(buffer.subarray(offset, offset + 8 + count * 4))) refuseSecurity()
  } catch (cause) { primary = cause; refuseSecurity(cause) } finally {
    if (token[0]) {
      try { api.close(token[0]) } catch (cause) { refuseSecurity(primary ? new AggregateError([primary, cause]) : cause) }
    }
  }
}
