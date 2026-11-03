/** Workspace revocation inventories explicit capability ACEs instead of process-local grant history. */
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileAccessProbe } from './state-access.ts'

/** Native descriptor operations preserve other trustees and inherited entries. */
export interface WorkspaceAceAccess extends FileAccessProbe {
  /** Inspect explicit allow and deny entries for the exact workspace SID. */
  hasExplicit(path: string): boolean
  /** Remove only those explicit entries; any failure throws. */
  removeExplicit(path: string): void
}

/**
 * Remove workspace capability entries across restarts and verify each former grant point.
 * Link objects are inspected without following their targets; descriptor operations must use no-follow handles.
 * @param root Canonical workspace root.
 * @param access Descriptor operations and the workspace token's native AccessCheck.
 * @returns Every matched location, including the root for post-revocation verification.
 */
export function revokeWorkspaceTree(root: string, access: WorkspaceAceAccess): readonly string[] {
  const points = new Set([root])
  const pending = [root]
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined) break
    const stat = lstatSync(path)
    if (access.hasExplicit(path)) points.add(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(path)) pending.push(join(path, name))
    }
  }
  for (const path of points) access.removeExplicit(path)
  for (const path of points) {
    for (const mask of [2, 4, 0x10000, 0x40]) {
      if (access.permits(path, mask)) throw new Error(`Workspace revocation left write access at ${path} (mask ${mask})`)
    }
    const parent = dirname(path)
    if (parent !== path && access.permits(parent, 0x40)) {
      throw new Error(`Workspace revocation left parent delete-child access at ${parent}`)
    }
  }
  return [...points]
}
