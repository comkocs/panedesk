export function syntheticSid(value: number, authority = 5): Buffer {
  const sid = Buffer.alloc(12); sid[0] = 1; sid[1] = 1; sid[7] = authority; sid.writeUInt32LE(value, 8)
  return sid
}
export function ace(type: number, flags: number, mask: number, sid: Buffer): Buffer {
  const bytes = Buffer.alloc(8 + sid.length); bytes[0] = type; bytes[1] = flags
  bytes.writeUInt16LE(bytes.length, 2); bytes.writeUInt32LE(mask, 4); sid.copy(bytes, 8)
  return bytes
}
export function acl(aces: Buffer[]): Buffer {
  const bytes = Buffer.alloc(8 + aces.reduce((sum, value) => sum + value.length, 0))
  bytes[0] = 2; bytes.writeUInt16LE(bytes.length, 2); bytes.writeUInt16LE(aces.length, 4)
  let offset = 8
  for (const value of aces) { value.copy(bytes, offset); offset += value.length }
  return bytes
}
export function descriptor(control: number, owner: Buffer, group: Buffer, dacl: Buffer | null, sacl: Buffer | null = null): Buffer {
  const parts = [owner, group, sacl, dacl]
  const bytes = Buffer.alloc(20 + parts.reduce((sum, part) => sum + (part?.length ?? 0), 0))
  bytes[0] = 1; bytes.writeUInt16LE(control, 2)
  let offset = 20
  for (const [index, value] of parts.entries()) {
    if (!value) continue
    bytes.writeUInt32LE(offset, 4 + index * 4); value.copy(bytes, offset); offset += value.length
  }
  return bytes
}
