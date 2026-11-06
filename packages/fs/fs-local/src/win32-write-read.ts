/** Mutation pre-reads authorize the opened identity and never reopen its display name. */
import { FsError } from '@panedesk/dsh-fs'
import type { AuthorizeRead, LineEndings } from './directory-legacy.ts'
import type { ReadHandle } from './read-handle.ts'

type Open = (signal?: AbortSignal) => Promise<ReadHandle>
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('File operation aborted / 文件操作已取消', 'FS_ABORTED')
}
async function opened(open: Open, signal?: AbortSignal, authorize?: AuthorizeRead): Promise<ReadHandle> {
  aborted(signal)
  const handle = await open(signal)
  try {
    aborted(signal)
    if (!handle.identity.regular) throw new FsError('Not a regular file / 不是普通文件', 'FS_NOT_REGULAR_FILE')
    authorize?.(handle.identity)
    return handle
  } catch (error) { await handle.close(); throw error }
}

/** Decode an authorized edit source, retaining its original newline convention.
 * @param open - Retained-directory read capability.
 * @param displayPath - Diagnostic name only.
 * @param signal - Optional cancellation before and during reads.
 * @param authorize - Optional policy checked before the first byte; omission is unrestricted.
 * @returns LF-normalized text and the original newline convention.
 */
export async function readWindowsEdit(open: Open, displayPath: string, signal?: AbortSignal,
  authorize?: AuthorizeRead): Promise<{ content: string; lineEndings: LineEndings }> {
  const handle = await opened(open, signal, authorize)
  const chunks: Buffer[] = []
  try {
    let position = 0
    for (;;) {
      aborted(signal)
      const buffer = Buffer.alloc(65536)
      const count = await handle.read(buffer, 0, buffer.length, position)
      if (!count) break
      chunks.push(buffer.subarray(0, count)); position += count
    }
  } finally { await handle.close() }
  aborted(signal)
  const bytes = Buffer.concat(chunks)
  let raw: string
  try {
    if (bytes.includes(0)) throw new TypeError('binary')
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new FsError(`Cannot edit "${displayPath}": not UTF-8 text / 无法编辑非 UTF-8 文本`, 'FS_NOT_TEXT', { cause })
  }
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return { content: raw.replaceAll('\r\n', '\n'), lineEndings: crlf > lf ? 'CRLF' : 'LF' }
}

/** Read an exclusive-byte-bounded diff basis; policy and capability errors propagate.
 * @param open - Retained-directory read capability.
 * @param limit - Exclusive byte limit.
 * @param signal - Optional cancellation before and during reads.
 * @param authorize - Optional opened-object policy; omission is unrestricted.
 * @returns Normalized text or null for missing, non-text, oversized or size-changed input.
 */
export async function readWindowsDiff(open: Open, limit: number, signal?: AbortSignal,
  authorize?: AuthorizeRead): Promise<string | null> {
  try {
    const handle = await opened(open, signal, authorize)
    let bytes: Buffer
    let total = 0
    const size = handle.identity.size
    try {
      if (size >= limit) return null
      bytes = Buffer.alloc(size + 1)
      while (total < bytes.length) {
        aborted(signal)
        const count = await handle.read(bytes, total, Math.min(65536, bytes.length - total), total)
        if (!count) break
        total += count
      }
    } finally { await handle.close() }
    aborted(signal)
    if (total !== size || bytes.subarray(0, total).includes(0)) return null
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)).replace(/\r\n/g, '\n') } catch (error) {
      if (!(error instanceof TypeError)) throw error
      return null
    }
  } catch (error) {
    if (error instanceof FsError) {
      if (error.code === 'FS_NOT_FOUND' || error.code === 'FS_NOT_REGULAR_FILE') return null
      throw error
    }
    if (error instanceof Error && 'code' in error) return null
    throw error
  }
}
