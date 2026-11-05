/** Shared owner-material path and file-identity checks for confined readers. */
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalPath } from './roots.ts'

/** Bilingual refusal shared by filesystem and native sandbox admission. */
export const OWNER_MATERIAL_DENIED = 'Owner identity material cannot be isolated; access denied. / 无法隔离所有者身份材料，已拒绝访问。'

/**
 * Resolve the shared private-storage inventory, including desktop registrations.
 * @param roots - Credential-provider directories or the caller's default private directory.
 * @param desktopPaths - Optional serialized desktop private directories.
 * @returns Original spellings and canonical targets, without inspecting file contents.
 */
export function ownerMaterialDirectories(roots: readonly string[], desktopPaths?: string): string[] {
  const paths = new Set(roots)
  if (desktopPaths !== undefined) {
    const parsed: unknown = JSON.parse(desktopPaths)
    if (!Array.isArray(parsed) || !parsed.every((path): path is string => typeof path === 'string')) {
      throw new Error('Desktop private paths must be a JSON string array / 桌面私有目录必须为字符串数组。')
    }
    for (const path of parsed) paths.add(path)
  }
  return [...new Set([...paths].flatMap(path => [resolve(path), canonicalPath(path)]))].sort()
}

/**
 * Reject workspaces inside owner storage, and Windows write grants over it.
 * @param workspace - Candidate workspace directory.
 * @param owners - Shared owner-material inventory.
 * @param windowsWrite - Whether this request creates Windows write authority.
 */
export function assertOwnerWorkspace(workspace: string, owners: readonly string[], windowsWrite = false): void {
  const contains = (root: string, path: string): boolean => {
    const suffix = relative(canonicalPath(root), canonicalPath(path))
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }
  if (owners.some(owner => contains(owner, workspace))) {
    throw new Error('Put the credentials file in a dedicated directory outside the workspace. / 把凭据文件放进单独目录，且与工作区互不包含。')
  }
  if (windowsWrite && owners.some(owner => contains(workspace, owner))) {
    throw new Error('The workspace contains an owner private directory; choose a workspace outside that directory tree. / 工作区包含所有者私密目录，请选择不含该目录树的工作区。')
  }
}

/**
 * Match protected files by canonical path or inode, including hard-link aliases.
 * @param path - Candidate host path.
 * @param roots - Current owner-material files and directories.
 * @param openedIdentity - Kernel identity of an already-open file; its final path is used without reopening. Omit for path inspection.
 * @returns Whether the candidate names protected material.
 */
export function isOwnerMaterial(
  path: string,
  roots: readonly string[],
  openedIdentity?: { dev: bigint; ino: bigint },
): boolean {
  const candidate = openedIdentity === undefined ? canonicalPath(path) : resolve(path)
  const identity = openedIdentity ?? (existsSync(candidate) ? statSync(candidate, { bigint: true }) : undefined)
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
      const protectedIdentity = statSync(resolved, { bigint: true })
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
