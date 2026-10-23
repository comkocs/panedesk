/** Bounded memory snapshots detect changes without attributing concurrent external writes. */
import { createHash } from 'node:crypto'
import { lstat, opendir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineMemoryAuditData, SeatDigest } from '@panedesk/dsh-seat'

/** Snapshot completeness is explicit; an absent path hash is not evidence of absence. */
export interface MemorySnapshot {
  hashes: ReadonlyMap<string, SeatDigest>
  complete: boolean
}

/** Hash registered files without following directory symlinks or exceeding aggregate bounds.
 * @param roots - canonical registered memory roots.
 * @param maxBytes - aggregate bytes read across files.
 * @param maxFiles - maximum inspected regular files.
 * @returns bounded evidence; filesystem errors make it incomplete.
 */
export async function snapshotMemory(roots: readonly string[], maxBytes: number, maxFiles: number): Promise<MemorySnapshot> {
  const hashes = new Map<string, SeatDigest>()
  let remaining = maxBytes
  let complete = true
  let entries = 0
  const visited = new Set<string>()
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return
    visited.add(path)
    if (++entries > maxFiles || remaining <= 0) { complete = false; return }
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) { complete = false; return }
      if (info.isDirectory()) {
        const directory = await opendir(path)
        for await (const entry of directory) {
          if (entries >= maxFiles || remaining <= 0) { complete = false; break }
          await visit(join(path, entry.name))
        }
      } else if (info.isFile()) {
        if (info.size > remaining) { complete = false; return }
        const file = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(info.size)
          let offset = 0
          while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
            if (bytesRead === 0) break
            offset += bytesRead
          }
          remaining -= offset
          const after = await file.stat()
          if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) { complete = false; return }
          hashes.set(path, createHash('sha256').update(buffer).digest('hex') as SeatDigest)
        } finally { await file.close() }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) complete = false
    }
  }
  for (const root of roots) await visit(root)
  return { hashes, complete }
}

/** Report changed paths only; concurrent authorship is deliberately unknown.
 * @param sessionId - audited session identity.
 * @param before - turn-start evidence.
 * @param after - turn-end evidence under the same bounds.
 * @returns audit payload without file contents or guessed authorship.
 */
export function compareMemory(
  sessionId: EngineMemoryAuditData['sessionId'], before: MemorySnapshot, after: MemorySnapshot,
): EngineMemoryAuditData {
  const paths: EngineMemoryAuditData['paths'][number][] = []
  for (const path of new Set([...before.hashes.keys(), ...after.hashes.keys()])) {
    const left = before.hashes.get(path) ?? null
    const right = after.hashes.get(path) ?? null
    if (left !== right) paths.push({ path, before: left, after: right })
  }
  return { sessionId, paths, attribution: 'unknown', complete: before.complete && after.complete,
    reason: before.complete && after.complete ? 'Concurrent external writes cannot be attributed.' : 'Memory snapshot is incomplete.' }
}
