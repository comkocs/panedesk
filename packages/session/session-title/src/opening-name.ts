/** Path-tolerant opening-message names; matching never changes the returned spelling. */
import type { OpeningNamePattern } from './types.ts'

/**
 * Find the first nonempty, whitespace-free value between the saved anchors.
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
      ? (() => { const space = text.slice(from).search(/\s/u); return space < 0 ? text.length : from + space })()
      : text.indexOf(right, from)
    if (p < 0) return undefined
    let start: number
    if (left.length === 0) {
      start = p
      while (start > 0 && !/[\s\\]/u.test(text[start - 1]!)) start--
    } else {
      const anchor = text.slice(0, p).lastIndexOf(left)
      start = anchor < 0 ? p : anchor + left.length
    }
    const value = message.slice(offsets[start], offsets[p])
    if (value.length > 0 && !/\s/u.test(value)) return value
    from = p + 1
  }
  return undefined
}
