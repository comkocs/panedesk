/** Read-only access probes keep state trust independent of ACE ownership heuristics. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

// File-specific access rights from WinNT.h; generic rights are mapped by AccessCheck.
const storageRights = [2, 4, 0x10, 0x100, 0x10000, 0x40, 0x40000, 0x80000]
const ancestorRights = [0x10000, 0x40000, 0x80000, 0x40]
const creationRights = [2, 4]

/**
 * Inspect storage and its descendants for writes or security-descriptor changes.
 * Ancestors deny replacement; only the nearest existing parent of a missing name denies creation.
 * @param directory State-record directory or exact record filename, not a workspace root.
 * @param probe AccessCheck backed by the token that will execute sandboxed work.
 * @returns The first dangerous permission, if present; native and filesystem failures throw.
 */
export function inspectStateAncestors(directory: string, probe: FileAccessProbe): UnsafeStateAccess | undefined {
  const pending = [{ path: resolve(directory), storage: true }]
  const checked = new Map<string, Set<number>>()
  const expanded = new Set<string>()
  while (pending.length > 0) {
    const start = pending.pop()
    if (start === undefined) break
    let missing = false
    for (let path = start.path; ; path = dirname(path)) {
      let info
      try { info = lstatSync(path) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (info === undefined) {
        missing = true
      } else {
        const storage = path === start.path && start.storage
        const masks = storage ? storageRights : [...ancestorRights, ...(missing ? creationRights : [])]
        const previous = checked.get(path) ?? new Set<number>()
        checked.set(path, previous)
        for (const mask of masks) {
          if (previous.has(mask)) continue
          previous.add(mask)
          if (probe.permits(path, mask)) return { path, mask }
        }
        const canonical = realpathSync.native(path)
        if (canonical !== path && !expanded.has(`${canonical}:${storage}`)) {
          expanded.add(`${canonical}:${storage}`)
          pending.push({ path: canonical, storage })
        }
        if (storage && info.isDirectory() && !expanded.has(path)) {
          expanded.add(path)
          for (const name of readdirSync(path)) pending.push({ path: join(path, name), storage: true })
        }
        missing = false
      }
      if (dirname(path) === path) break
    }
  }
  return undefined
}
