/** Path-tolerant opening-message names; matching never changes the returned spelling. */
import type { OpeningNamePattern } from './types.ts'

/**
 * Read the first path's directory name without accessing the filesystem.
 * @param message - opening text containing a quoted or whitespace-delimited path.
 * @returns the containing directory for a file-like last segment, otherwise the last segment.
 */
export function extractOpeningFolder(message: string): string | undefined {
  const tokens = message.match(/"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[^\s"'`，。；！？<>]+/gu) ?? []
  for (const token of tokens) {
    const path = token.replace(/^["'`]|["'`]$/gu, '').replaceAll('\\', '/')
    if (!path.includes('/') || /^[a-z][a-z\d+.-]*:\/\//iu.test(path)) continue
    const parts = path.replace(/[,.!?;:）)\]】]+$/u, '').split('/').filter(Boolean)
    const last = parts.pop()
    if (last === undefined) continue
    const folder = /\.[^.]+$/u.test(last) ? parts.pop() : last
    if (folder !== undefined && folder !== '.' && folder !== '..' && !/^[a-z]:$/iu.test(folder)) return folder
  }
  return undefined
}

/**
 * Find the first nonempty value between the saved anchors, trimming outer whitespace.
 * @param message - the first human message, unchanged.
 * @param pattern - sample and anchors selected in General Settings.
 * @returns the original matched text, or undefined when no candidate matches.
 */
export function extractOpeningName(message: string, pattern: OpeningNamePattern): string | undefined {
  const normalize = (text: string): string => text.replaceAll('/', '\\').toLowerCase()
  const left = normalize(pattern.left)
  const right = normalize(pattern.right)
  // Match against an index-preserving string even when Unicode lowercasing expands a character.
  const folded: string[] = []
  const offsets: number[] = []
  let offset = 0
  for (const character of message) {
    const normalized = normalize(character)
    for (let index = 0; index < normalized.length; index++) offsets.push(offset)
    folded.push(normalized)
    offset += character.length
  }
  offsets.push(message.length)
  const text = folded.join('')
  let from = 0
  while (from <= text.length) {
    const p = right.length === 0
      ? text.length
      : text.indexOf(right, from)
    if (p < 0) return undefined
    let start: number
    if (left.length === 0) {
      start = p
      while (start > 0 && !/[\\\r\n"'`]/u.test(text[start - 1]!)) start--
    } else {
      const anchor = text.slice(0, p).lastIndexOf(left)
      start = anchor < 0 ? p : anchor + left.length
    }
    const value = message.slice(offsets[start], offsets[p]).trim()
    if (value.length > 0) return value
    from = p + 1
  }
  return undefined
}
