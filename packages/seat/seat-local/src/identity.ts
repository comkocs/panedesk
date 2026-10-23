/** Canonical path ownership shared by directory admission and memory-write gates. */
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { SeatDefinition, SeatName, SeatRejected } from '@panedesk/dsh-seat'
import { rejected } from './errors.ts'

/** Resolve symlinks through the nearest existing ancestor, including not-yet-created files.
 * @param target - absolute target path.
 * @returns canonical existing ancestor plus unresolved child segments.
 */
export async function canonicalPath(target: string): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error('An absolute path is required')
  const suffix: string[] = []
  let ancestor = path.normalize(target)
  while (true) {
    try { return path.join(await realpath(ancestor), ...suffix) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

/** Compare path segments, not string prefixes; Windows callers select its explicit path rules.
 * @param root - canonical registered root.
 * @param target - canonical target.
 * @param platform - native path policy; Windows tests may select win32 without filesystem access.
 * @returns whether target lies at or below root.
 */
export function containsPath(root: string, target: string, platform: 'posix' | 'win32' = 'posix'): boolean {
  const implementation = platform === 'win32' ? path.win32 : path.posix
  const relative = implementation.relative(platform === 'win32' ? root.toLowerCase() : root,
    platform === 'win32' ? target.toLowerCase() : target)
  return relative === '' || (!implementation.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${implementation.sep}`))
}

/** Resolve all owners of a startup or additional directory; never select a first match.
 * @param cwd - requested working directory.
 * @param definitions - authorized node-local catalog.
 * @returns matching definitions in catalog order.
 */
export async function directoryOwners(cwd: string, definitions: readonly SeatDefinition[]): Promise<SeatDefinition[]> {
  const target = await canonicalPath(cwd)
  const owners: SeatDefinition[] = []
  for (const definition of definitions) {
    for (const directory of definition.directories) {
      if (containsPath(await canonicalPath(directory.path), target, process.platform === 'win32' ? 'win32' : 'posix')) {
        owners.push(definition)
        break
      }
    }
  }
  return owners
}

/** Deny writes to another seat's registered memory; reads and unregistered paths are unaffected.
 * @param target - actual target resolved by the executing tool.
 * @param seat - trusted binding identity, null for a free window.
 * @param definitions - complete local catalog, including shared roots.
 * @returns null when allowed, otherwise actionable ownership refusal.
 */
export async function checkMemoryWrite(target: string, seat: SeatName | null,
  definitions: readonly SeatDefinition[]): Promise<SeatRejected | null> {
  const canonical = await canonicalPath(target)
  const platform = process.platform === 'win32' ? 'win32' : 'posix'
  const own = definitions.find(definition => definition.seat === seat)?.memoryDirectories ?? []
  const registered = new Set(definitions.flatMap(definition => [...definition.memoryDirectories]))
  let protectedPath = false
  for (const root of registered) {
    if (containsPath(await canonicalPath(root), canonical, platform)) { protectedPath = true; break }
  }
  if (!protectedPath) return null
  for (const root of own) if (containsPath(await canonicalPath(root), canonical, platform)) return null
  return rejected('memory-seat-mismatch', 'This window cannot write the registered memory directory.',
    own.length ? `Use seat_write with an authorized memory directory: ${own.join(', ')}.` : 'Open the owning seat before writing its memory directory.')
}
