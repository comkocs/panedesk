/** Replacement preparation owns the old handle until publication or discard. */
import { FsError } from '@panedesk/dsh-fs'

/** A named data stream, never a public path component. */
export interface BackupStream {
  id: number
  attributes: number
  name: string
  data: Buffer
}

/** Handle-only metadata operations; a failed detection must throw, never return absence. */
export interface ReplacementMetadataApi {
  basic(token: number): Buffer
  compression(token: number): number
  resourceAttributes(token: number): boolean
  enterpriseProtected(token: number): boolean
  streams(token: number): BackupStream[]
  setBasic(token: number, basic: Buffer): void
  setCompression(token: number, format: number): void
  writeStream(token: number, stream: BackupStream): void
}

/** Prepare metadata without modifying the retained old file.
 * @param api - Native handle operations, including independent protection detection.
 * @param old - Retained old-file token.
 * @returns Preparation callback for the secured, flushed replacement handle.
 */
export function captureReplacementMetadata(api: ReplacementMetadataApi, old: number): (stage: number) => void {
  const detect = <T>(query: () => T): T => {
    try { return query() } catch (cause) {
      throw new FsError('Protection detection failed / 保护检测失败', 'FS_IO_ERROR', { cause })
    }
  }
  const basic = detect(() => api.basic(old))
  const flags = checkedAttributes(basic)
  if (detect(() => api.resourceAttributes(old))) refuse('Security resource attributes are unsupported / 不支持安全资源属性')
  if (detect(() => api.enterpriseProtected(old))) refuse('Enterprise-protected replacement is unsupported / 不支持覆盖企业保护文件; Encrypted / possibly enterprise-protected file / 已加密 / 可能受企业保护')
  const compression = api.compression(old)
  if (compression !== 0 && compression !== 2) refuse('Unsupported compression format / 不支持该压缩格式')
  const streams = checkedStreams(api.streams(old))
  return (stage) => {
    const replacement = api.basic(stage)
    const replacementFlags = checkedAttributes(replacement)
    const attributePairs = new Map([[0x02 * 256 + 0x20, 0x22], [0x04 * 256 + 0x20, 0x24],
      [0x20 * 256 + 0x80, 0x20], [0x20 * 256 + 0x20, 0x20]])
    const attributes = attributePairs.get((flags & ~0x800) * 256 + (replacementFlags & ~0x800))
    if (attributes === undefined) refuse('Unverified file attribute combination / 未核实的文件属性组合')
    if (detect(() => api.resourceAttributes(stage))) refuse('Security resource attributes are unsupported / 不支持安全资源属性')
    if (detect(() => api.enterpriseProtected(stage))) refuse('Enterprise-protected replacement is unsupported / 不支持覆盖企业保护文件; Encrypted / possibly enterprise-protected file / 已加密 / 可能受企业保护')
    const existing = new Set(checkedStreams(api.streams(stage)).map(stream => stream.name))
    api.setCompression(stage, compression)
    if (api.compression(stage) !== compression) refuse('Compression verification failed / 压缩格式复核失败')
    for (const stream of streams) if (!existing.has(stream.name)) api.writeStream(stage, stream)
    const merged = Buffer.from(replacement)
    basic.copy(merged, 0, 0, 8)
    // Compression is handled separately; ordinary attributes follow the observed pairs only.
    merged.writeUInt32LE(attributes, 32)
    api.setBasic(stage, merged)
  }
}

function refuse(message: string): never { throw new FsError(message, 'FS_IO_ERROR') }

function checkedAttributes(basic: Buffer): number {
  if (basic.length !== 40) refuse('Unverified file attributes / 未核实的文件属性')
  const flags = basic.readUInt32LE(32)
  if (flags & 0x4000) refuse('EFS replacement is unsupported / 不支持覆盖 EFS 加密文件; Encrypted / possibly enterprise-protected file / 已加密 / 可能受企业保护')
  if (flags & 1) refuse('Read-only replacement is unsupported / 不支持覆盖只读文件')
  if (flags & ~(0x26 | 0x80 | 0x800)) refuse('Unverified file attributes / 未核实的文件属性')
  return flags
}

function checkedStreams(streams: BackupStream[]): BackupStream[] {
  const named: BackupStream[] = []
  const names = new Set<string>()
  for (const stream of streams) {
    // Base data, EAs, security and ObjectId are never replayed over the replacement.
    if ([1, 2, 3, 7].includes(stream.id)) continue
    if (stream.id !== 4 || stream.attributes !== 0 || !/^:[^:\s\x00/\\]+:\$DATA$/u.test(stream.name)
      || names.has(stream.name)) refuse('Unknown backup stream / 未知备份流')
    names.add(stream.name)
    named.push({ ...stream, data: Buffer.from(stream.data) })
  }
  return named
}
