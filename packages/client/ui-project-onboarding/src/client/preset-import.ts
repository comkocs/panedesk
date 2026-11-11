/** Opening preset imports share the existing opening-name extraction rules. */
import { extractOpeningFolder, extractOpeningName } from '@panedesk/dsh-session-title/client'
import type { OpeningNamePattern } from '@panedesk/dsh-session-title/client'
import type { OpeningPreset } from '../types.ts'
import { presetName } from '../preset-name.ts'

/** Infer a display name without changing the opening sentence.
 * @param prompt - original opening sentence.
 * @param pattern - saved General Settings selection.
 * @returns A name of at most twenty characters.
 */
export function openingPresetName(prompt: string, pattern?: OpeningNamePattern): string {
  return presetName((pattern ? extractOpeningName(prompt, pattern) : undefined) ?? extractOpeningFolder(prompt) ?? prompt)
}

/** Directory written in one pasted line, ahead of the registered-workspace guess.
 * @param line - one opening sentence.
 * @returns The line's own folder, or none when it names no path.
 */
export function pastedDirectory(line: string): string | undefined {
  const token = (line.match(/"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[A-Za-z]:\\[^\s"'`，。；！？<>]+|\/[^\s"'`，。；！？<>]+/u) ?? [])[0]
  if (token === undefined) return undefined
  const path = token.replace(/^["'`]|["'`]$/gu, '').replace(/[,.!?;:）)\]】]+$/u, '')
  const separator = path.includes('\\') ? '\\' : '/'
  const end = path.replace(/[\\/]+$/u, '').lastIndexOf(separator)
  const folder = end > 0 && path.slice(end + 1).includes('.') ? path.slice(0, end) : path
  return folder === '' || /^[A-Za-z]:$/u.test(folder) ? undefined : folder
}

/** Parse multiline sentences or a markdown table into editable, not yet persisted rows.
 * @param text - pasted text.
 * @param table - whether to read a markdown header.
 * @returns Rows whose missing directories or names must be completed before saving.
 */
export function importPresets(text: string, table: boolean): OpeningPreset[] {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (!table) return lines.map(prompt => ({ name: '', prompt, directories: [pastedDirectory(prompt) ?? ''].filter(Boolean) }))
  const cells = (line: string) => line.replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u)
    .map(cell => cell.trim().replaceAll('\\|', '|').replace(/^`|`$/gu, ''))
  const rows = lines.map(cells)
  const header = rows.findIndex(row => row.some(cell => /^开窗句(?:原文|[（(]原文[）)])$/u.test(cell)))
  if (header < 0) return []
  const columns = rows[header]!
  const promptColumn = columns.findIndex(cell => /^开窗句(?:原文|[（(]原文[）)])$/u.test(cell))
  const directoryColumn = columns.indexOf('开窗目录')
  const modelColumn = columns.findIndex(cell => cell.includes('模型'))
  const permissionColumn = columns.findIndex(cell => cell.includes('权限'))
  return rows.slice(header + 1).filter(row => !row.every(cell => /^:?-+:?$/u.test(cell)))
    .filter(row => Boolean(row[promptColumn])).map(row => ({
      name: '', prompt: row[promptColumn]!,
      directories: (row[directoryColumn] ?? '').split(/<br\s*\/?\s*>/iu).map(path => path.trim()).filter(Boolean),
      ...(row[modelColumn] ? { model: row[modelColumn] } : {}),
      ...(row[permissionColumn] ? { permission: row[permissionColumn] } : {}),
    }))
}
