/** Independent cryptographic identifiers for call accounting and artifact records. */
import { randomBytes } from 'node:crypto'

/** Generate an RFC 4122 version 4 identifier without consuming the process UUID function.
 * @returns UUID with 122 random bits from the operating system cryptographic generator.
 */
export function ledgerUuid(): string {
  const bytes = randomBytes(16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
