/** Shared owner-material path and file-identity checks for confined readers. */
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalPath } from './roots.ts'

/** Bilingual refusal shared by filesystem and native sandbox admission. */
export const OWNER_MATERIAL_DENIED = 'Owner identity material cannot be isolated; access denied. / 无法隔离所有者身份材料，已拒绝访问。'

/**
 * Match protected files by canonical path or inode, including hard-link aliases.
 * @param path - Candidate host path.
 * @param roots - Current owner-material files and directories.
 * @returns Whether the candidate names protected material.
 */
export function isOwnerMaterial(path: string, roots: readonly string[]): boolean {
  const candidate = canonicalPath(path)
  const identity = existsSync(candidate) ? statSync(candidate) : undefined
  return roots.some((root) => {
    const canonical = canonicalPath(root)
    const suffix = relative(canonical, candidate)
    if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))) return true
    if (identity === undefined || !existsSync(canonical)) return false
    const visited = new Set<string>()
    const matchesIdentity = (entry: string): boolean => {
      const resolved = canonicalPath(entry)
      if (visited.has(resolved)) return false
      visited.add(resolved)
      const protectedIdentity = statSync(resolved)
      if (identity.dev === protectedIdentity.dev && identity.ino === protectedIdentity.ino) return true
      return protectedIdentity.isDirectory()
        && readdirSync(resolved).some(child => matchesIdentity(join(resolved, child)))
    }
    return matchesIdentity(canonical)
  })
}

/**
 * Resolve mount/profile paths and refuse aliases a path-only backend cannot isolate.
 * @param roots - Current owner-material files and directories.
 * @returns Canonical private directories, created before native isolation, plus external symlink targets.
 * @throws When an owner file has extra hard links or directory inspection fails.
 */
export function isolatedOwnerPaths(roots: readonly string[]): string[] {
  const paths = new Set<string>()
  const visited = new Set<string>()
  const inspect = (path: string): void => {
    const canonical = canonicalPath(path)
    if (visited.has(canonical)) return
    visited.add(canonical)
    const info = statSync(canonical)
    if (info.isFile() && info.nlink !== 1) throw new Error(OWNER_MATERIAL_DENIED)
    if (info.isDirectory()) {
      for (const entry of readdirSync(canonical)) {
        const child = join(canonical, entry)
        if (lstatSync(child).isSymbolicLink()) paths.add(canonicalPath(child))
        inspect(child)
      }
    } else if (!info.isFile()) throw new Error(OWNER_MATERIAL_DENIED)
  }
  for (const path of roots) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      paths.add(resolve(path))
      paths.add(canonicalPath(path))
      inspect(path)
    } catch (error) {
      throw new Error(OWNER_MATERIAL_DENIED, { cause: error })
    }
  }
  return [...paths]
}
