/** Opening text is rendered once; persisted snapshots are replayed without rereading sources. */
import { open } from 'node:fs/promises'
import type { SeatName, SeatTaskId, SeatText } from '@panedesk/dsh-seat'
import { refuse } from './errors.ts'
import { digest } from './store.ts'

/** Immutable opening inputs captured before creation. */
export interface FrozenOpening {
  variables: { seat: SeatName; date: string; taskId: SeatTaskId | null }
  text: string
  digest: ReturnType<typeof digest>
}

/** Read a bounded text or a unique Markdown heading section without executing its contents.
 * @param source - catalog-owned text or pointer.
 * @param maxBytes - complete source and rendered text byte bound.
 * @returns selected text.
 */
export async function readSeatText(source: SeatText, maxBytes: number): Promise<string> {
  let text: string
  if (source.kind === 'text') text = source.text
  else {
    const file = await open(source.path, 'r')
    try {
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > maxBytes) refuse('invalid-definition', 'Opening source exceeds its byte limit.', 'Shorten the selected opening source.')
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } finally { await file.close() }
  }
  if (Buffer.byteLength(text) > maxBytes) refuse('invalid-definition', 'Opening source exceeds its byte limit.', 'Shorten the selected opening source.')
  if (source.kind === 'text' || source.section === undefined) return text
  const lines = text.split('\n')
  const matches = lines.flatMap((line, index) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, '').trim() === source.section ? [index] : [])
  if (matches.length !== 1) refuse('invalid-definition', 'Opening section must match exactly one heading.', 'Select a unique opening section.')
  const start = matches[0]
  if (start === undefined) refuse('invalid-definition', 'Opening section is missing.', 'Select an existing heading.')
  const level = lines[start]?.match(/^#+/)?.[0].length
  if (level === undefined) refuse('invalid-definition', 'Opening heading is invalid.', 'Select a Markdown heading.')
  let end = start + 1
  while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[end] ?? ''))) end += 1
  return lines.slice(start + 1, end).join('\n')
}

/** Render the three supported variables in one pass; backslash escapes an opening delimiter.
 * @param source - literal template, using seat, date and taskId placeholders.
 * @param variables - frozen host inputs; missing task identity renders an empty string.
 * @param maxBytes - final UTF-8 bound after substitution.
 * @returns immutable replay text and its digest.
 */
export function renderOpening(source: string, variables: FrozenOpening['variables'], maxBytes: number): FrozenOpening {
  if (!variables.seat || !/^\d{4}-\d{2}-\d{2}$/.test(variables.date)) {
    refuse('invalid-definition', 'Opening seat and date are required.', 'Resolve the seat and host date before opening.')
  }
  const text = source.replace(/\\\{\{|\{\{([^{}]+)\}\}/g, (match: string, key: string | undefined) => {
    if (match === '\\{{') return '{{'
    switch (key?.trim()) {
      case 'seat': return variables.seat
      case 'date': return variables.date
      case 'taskId': return variables.taskId ?? ''
      default: return refuse('invalid-definition', `Unknown opening variable ${key}.`, 'Use seat, date or taskId variables; escape literal delimiters with a backslash.')
    }
  })
  if (Buffer.byteLength(text) > maxBytes) refuse('invalid-definition', 'Rendered opening exceeds its byte limit.', 'Shorten the opening template or variable values.')
  return { variables: { ...variables }, text, digest: digest(text) }
}
