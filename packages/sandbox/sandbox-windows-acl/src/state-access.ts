/** Read-only access probes keep state trust independent of ACE ownership heuristics. */
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** The same restricted token is retained for every object in one inspection. */
export interface FileAccessProbe {
  /** Check a specific file access mask; native failures must throw. */
  permits(path: string, mask: number): boolean
}

/** A writable object makes the entire state-record ancestry untrusted. */
export interface UnsafeStateAccess {
  readonly path: string
  readonly mask: number
}

/**
 * Inspect state storage and every ancestor, including the volume root.
 * Missing names are checked at their existing parents before creation.
 * @param directory State-record directory, not a workspace root.
 * @param probe AccessCheck backed by the token that will execute sandboxed work.
 * @returns The first write, append, delete or delete-child permission, if present.
 */
export function inspectStateAncestors(directory: string, probe: FileAccessProbe): UnsafeStateAccess | undefined {
  const pending = [resolve(directory)]
  const checked = new Set<string>()
  while (pending.length > 0) {
    const start = pending.pop()
    if (start === undefined) break
    for (let path = start; !checked.has(path); path = dirname(path)) {
      checked.add(path)
      let exists = true
      try { lstatSync(path) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        exists = false
      }
      if (exists) {
        const canonical = realpathSync.native(path)
        if (canonical !== path) pending.push(canonical)
        for (const mask of [2, 4, 0x10000, 0x40]) {
          if (probe.permits(path, mask)) return { path, mask }
        }
      }
      if (dirname(path) === path) break
    }
  }
  return undefined
}
