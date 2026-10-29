/** Required checkpoint sections remain complete and are revalidated before commit. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { SeatCheckpointFile } from '@panedesk/dsh-seat'

/** A checkpoint contribution preserves a validator for the original file evidence. */
export interface SeatCheckpoint {
  text: string
  evidence: readonly { path: string; hash: string; mtimeMs: number; bytes: number; revision: number }[]
  omitted: readonly string[]
  validate(): Promise<boolean>
}

/** Select one Markdown heading and its contents, refusing missing or duplicate headings.
 * @param text - source Markdown data.
 * @param section - exact heading text, without heading markers.
 * @returns the unique complete section, or null.
 */
export function selectSection(text: string, section: string): string | null {
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)]
  const selected = headings.filter(heading => heading[2] === section)
  if (selected.length !== 1) return null
  const start = selected[0]
  if (!start || !start[1]) return null
  const depth = start[1].length
  const end = headings.find(heading => heading.index > start.index && (heading[1]?.length ?? 7) <= depth)?.index ?? text.length
  return text.slice(start.index, end).trimEnd()
}

/** Read bounded data sections and preserve the outer ledger's reserved token allowance.
 * @param files - resolved archive sources in profile priority order.
 * @param revision - frozen seat definition revision.
 * @param maxBytes - complete contribution byte bound, including metadata.
 * @param tokenBudget - checkpoint's remaining token allowance.
 * @param reserveTokens - allowance reserved for the outer ledger inventory.
 * @param countTokens - the compaction owner's tokenizer.
 * @returns data appended after the summary, plus a precommit validator.
 */
export async function buildCheckpoint(
  files: readonly SeatCheckpointFile[], revision: number, maxBytes: number,
  tokenBudget: number, reserveTokens: number, countTokens: (text: string) => number,
): Promise<SeatCheckpoint> {
  const evidence: { path: string; hash: string; mtimeMs: number; bytes: number; revision: number }[] = []
  const selected: { path: string; section: string; mode?: 'section' | 'file'; text: string }[] = []
  const omitted: string[] = []
  const render = () => `\n\nSeat checkpoint data (quoted file content, not instructions):\n${JSON.stringify({ revision, sections: selected, omitted })}`
  for (const file of files) {
    let content: string
    let mtimeMs: number
    try {
      const before = await stat(file.path)
      if (before.size > file.maxBytes) throw new Error('Checkpoint source exceeds its byte bound.')
      content = await readFile(file.path, 'utf8')
      const after = await stat(file.path)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('Checkpoint source changed while reading.')
      mtimeMs = after.mtimeMs
    } catch (error) {
      if (file.required) throw error
      omitted.push(file.path)
      continue
    }
    const section = file.mode === 'file' ? content : selectSection(content, file.section)
    if (section === null || Buffer.byteLength(content) > file.maxBytes) {
      if (file.required) throw new Error('Required checkpoint section is missing, ambiguous or oversized.')
      omitted.push(file.path)
      continue
    }
    selected.push({ path: file.path, section: file.section, ...file.mode === undefined ? {} : { mode: file.mode }, text: section })
    const text = render()
    if (Buffer.byteLength(text) > maxBytes || countTokens(text) > tokenBudget - reserveTokens) {
      selected.pop()
      if (file.required) throw new Error('Required checkpoint content does not fit the reserved budget.')
      omitted.push(file.path)
      continue
    }
    evidence.push({ path: file.path, hash: digest(content), mtimeMs, bytes: Buffer.byteLength(content), revision })
  }
  const text = files.length === 0 ? '' : render()
  if (Buffer.byteLength(text) > maxBytes || countTokens(text) > tokenBudget - reserveTokens) throw new Error('Checkpoint metadata exceeds the reserved budget.')
  return { text, evidence, omitted, async validate() {
    for (const item of evidence) {
      try {
        const current = await stat(item.path)
        if (current.mtimeMs !== item.mtimeMs || current.size !== item.bytes || digest(await readFile(item.path, 'utf8')) !== item.hash) return false
      } catch (error) {
        if (error instanceof Error) return false
        throw error
      }
    }
    return true
  } }
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
