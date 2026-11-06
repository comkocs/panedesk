/** Bounded self-relative descriptor parsing supports inherited-permission detection. */
import { FsError } from '@panedesk/dsh-fs'

/** Parsed components retain the original ACE order and bytes. */
export interface SecurityDescriptor {
  control: number
  owner: Buffer
  group: Buffer
  sacl: Buffer | null
  dacl: Buffer | null
}

/** Refuse individually configured or unobservable permissions without changing the file.
 * @param cause - Failed detection, when available.
 * @returns Never returns.
 */
export function refuseSecurity(cause?: unknown): never {
  throw new FsError('This file has individually configured permissions; direct replacement is not supported yet / 该文件有单独设置的权限，暂不支持直接覆盖', 'FS_IO_ERROR', { cause })
}

/** Parse a complete self-relative descriptor returned by the operating system.
 * @param bytes - Native descriptor allocation, bounded by the query result.
 * @returns Validated component copies.
 */
export function parseSecurityDescriptor(bytes: Buffer): SecurityDescriptor {
  if (bytes.length < 20 || bytes[0] !== 1 || bytes[1] !== 0 || !(bytes.readUInt16LE(2) & 0x8000)) refuseSecurity()
  const sid = (offset: number): Buffer => {
    if (offset < 20 || offset + 8 > bytes.length || bytes[offset] !== 1) return refuseSecurity()
    const count = bytes.readUInt8(offset + 1)
    if (count > 15 || offset + 8 + count * 4 > bytes.length) return refuseSecurity()
    return Buffer.from(bytes.subarray(offset, offset + 8 + count * 4))
  }
  const acl = (offset: number): Buffer | null => {
    if (!offset) return null
    if (offset < 20 || offset + 8 > bytes.length || bytes[offset] !== 2) return refuseSecurity()
    const size = bytes.readUInt16LE(offset + 2)
    if (size < 8 || offset + size > bytes.length) return refuseSecurity()
    const result = Buffer.from(bytes.subarray(offset, offset + size))
    securityAces(result)
    return result
  }
  return { control: bytes.readUInt16LE(2), owner: sid(bytes.readUInt32LE(4)), group: sid(bytes.readUInt32LE(8)),
    sacl: acl(bytes.readUInt32LE(12)), dacl: acl(bytes.readUInt32LE(16)) }
}

/** Read ordinary allow, deny, audit and label ACEs; unknown formats are not silently discarded.
 * @param acl - Validated ACL allocation.
 * @returns ACE copies in their original order.
 */
export function securityAces(acl: Buffer): Buffer[] {
  if (acl.length < 8 || acl[0] !== 2 || acl.readUInt16LE(2) !== acl.length) refuseSecurity()
  const result: Buffer[] = []
  let offset = 8
  for (let index = 0; index < acl.readUInt16LE(4); index++) {
    if (offset + 16 > acl.length) refuseSecurity()
    const size = acl.readUInt16LE(offset + 2)
    if (![0, 1, 2, 17].includes(acl.readUInt8(offset)) || size < 16 || offset + size > acl.length
      || acl[offset + 8] !== 1 || acl.readUInt8(offset + 9) > 15 || size !== 16 + acl.readUInt8(offset + 9) * 4) refuseSecurity()
    result.push(Buffer.from(acl.subarray(offset, offset + size)))
    offset += size
  }
  if (offset !== acl.length) refuseSecurity()
  return result
}
