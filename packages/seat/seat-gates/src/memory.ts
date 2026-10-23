/** Memory ownership is a mistake-prevention policy, not a shell security boundary. */
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { SeatFailure, SeatName } from '@panedesk/dsh-seat'

/** Resolve symlinks through the nearest existing ancestor of a future write.
 * @param path - absolute or cwd-relative target.
 * @param cwd - trusted executor directory.
 * @returns canonical target; permission and unexpected filesystem failures propagate.
 */
export async function canonicalWritePath(path: string, cwd: string): Promise<string> {
  let ancestor = resolve(cwd, path)
  const suffix: string[] = []
  for (;;) {
    try { return resolve(await realpath(ancestor), ...suffix.reverse()) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.push(relative(parent, ancestor))
      ancestor = parent
    }
  }
}

/** Segment-aware containment never confuses sibling path prefixes.
 * @param root - canonical registered root.
 * @param target - canonical destination.
 * @returns whether the target is the root or one of its descendants.
 */
export function containsPath(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Decide ownership using canonical registered roots, including explicitly shared roots.
 * @param target - canonical destination.
 * @param seat - trusted binding, null for a free window.
 * @param registrations - all registered memory roots and their authorized seats.
 * @returns refusal with real authorized directories, or null for unrestricted writes.
 */
export function checkMemoryWrite(
  target: string, seat: SeatName | null, registrations: readonly { path: string; seats: readonly SeatName[] }[],
): SeatFailure | null {
  const matches = registrations.filter(root => containsPath(root.path, target))
  if (matches.length === 0 || (seat !== null && matches.every(root => root.seats.includes(seat)))) return null
  const authorized = seat === null ? [] : registrations.filter(root => root.seats.includes(seat)).map(root => root.path)
  return {
    code: 'memory-seat-mismatch', message: 'This memory directory is not authorized for the current seat.',
    alternative: authorized.length ? `Use seat_write with an authorized memory directory: ${authorized.join(', ')}.` : 'Open the owning seat before writing its memory directory.',
    retryable: false, effectState: 'none',
  }
}

/** Extract only literal destinations from recognizable shell write syntax.
 * @param command - shell source, never executed for classification.
 * @returns certain destinations; dynamic syntax requires audit instead of attribution.
 */
export function literalWriteTargets(command: string): readonly string[] {
  if (/[$`]|<<|\$\(|\n/.test(command)) return []
  const result: string[] = []
  const literal = String.raw`(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|<>]+))`
  for (const match of command.matchAll(new RegExp(String.raw`(?:^|[^<])>>?\s*${literal}`, 'g'))) {
    const target = match[1] ?? match[2] ?? match[3]
    if (target !== undefined) result.push(target)
  }
  for (const segment of command.split(/\s*(?:;|&&|\|\|)\s*/)) {
    const match = /^(tee|cp|mv|install|rm)\s+(.+)$/.exec(segment.trim())
    if (!match?.[2]) continue
    const words = Array.from(match[2].matchAll(new RegExp(literal, 'g')), item => item[1] ?? item[2] ?? item[3])
      .filter((word): word is string => word !== undefined)
    if (words.some(word => word.startsWith('-'))) continue
    if (match[1] === 'rm' || match[1] === 'tee') result.push(...words)
    else if (words.length === 2) {
      const [source, target] = words
      if (target !== undefined) result.push(target)
      if (match[1] === 'mv' && source !== undefined) result.push(source)
    }
  }
  return [...new Set(result)]
}
