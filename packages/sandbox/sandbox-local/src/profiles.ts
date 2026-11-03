/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @panedesk/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@panedesk/node-addon-system/landlock-run'
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertUnprotectedRoots, canonicalPath, isolatedOwnerPaths, rootsOverlap, SandboxUnavailableError, writableRoots } from '@panedesk/dsh-sandbox'
import type { ProtectedInputEnforcement, SandboxPolicy } from '@panedesk/dsh-sandbox'

/** Test containment after callers have canonicalized both paths. */
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/**
 * Resolve private stores outside the workspace a command must read.
 * @param policy - Resolved confinement policy.
 * @returns Private paths to exclude before admitting the command.
 */
export function ownerDirectories(policy: SandboxPolicy): string[] {
  const paths = isolatedOwnerPaths(policy.unreadablePaths ?? [])
  if (paths.some(path => rootsOverlap(path, policy.workspaceRoot))) {
    throw new SandboxUnavailableError(policy.mode,
      'Put the credentials file in a dedicated directory outside the workspace. / 把凭据文件放进单独目录，且与工作区互不包含。')
  }
  return paths
}

/** Ancestors need stable names while their unrelated children remain writable. */
function protectedParents(root: string, path: string): string[] {
  const parents: string[] = []
  if (!contains(root, path)) return parents
  for (let parent = dirname(path); parent !== root && contains(root, parent); parent = dirname(parent)) {
    parents.unshift(parent)
  }
  return parents
}

/** Unresolvable names and link replacements require host-side input validation. */
function mountPath(path: string): string | undefined {
  let canonical: string
  try { canonical = canonicalPath(path) }
  catch (error) {
    // An inaccessible or cyclic input must not make unrelated commands unavailable.
    if ((error as NodeJS.ErrnoException).code === undefined) throw error
    return undefined
  }
  for (let prefix = canonical; ; prefix = dirname(prefix)) {
    let stat
    try { stat = lstatSync(prefix) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === undefined) throw error
      return undefined
    }
    // canonicalPath preserves a dangling link's spelling when realpath cannot resolve it.
    if (stat.isSymbolicLink()) return undefined
    if (prefix === canonical && !stat.isFile() && !stat.isDirectory()) return undefined
    if (dirname(prefix) === prefix) return canonical
  }
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * Mount destinations use real paths; unrepresentable inputs and link-name changes
 * require host-side validation rather than a profile that prevents all commands.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--new-session']
  if (policy.mode === 'workspace-write') {
    const workspace = canonicalPath(policy.workspaceRoot)
    const protectedPaths = policy.protectedPaths ?? []
    const canonical = protectedPaths.map(mountPath).filter(path => path !== undefined)
    const temporary = ![...protectedPaths.map(path => resolve(path)), ...canonical]
      .some(path => contains('/tmp', path) || contains(path, '/tmp'))
    if (temporary) args.push('--tmpfs', '/tmp')
    args.push('--bind', workspace, workspace)
    const paths = [...new Set(canonical.flatMap(path => contains(path, workspace) ? [workspace] : contains(workspace, path) ? [path] : []))]
      .sort((a, b) => a.length - b.length)
      .filter((path, index, sorted) => !sorted.slice(0, index).some(parent => contains(parent, path)))
    const parents = [...new Set(paths.flatMap(path => protectedParents(workspace, path)))].sort((a, b) => a.length - b.length)
    for (const parent of parents) {
      // A mount point cannot be renamed or unlinked, but its ordinary children remain writable.
      args.push('--bind', parent, parent)
    }
    for (const path of paths) args.push('--ro-bind', path, path)
  }
  for (const path of ownerDirectories(policy)) {
    if (statSync(path).isDirectory()) args.push('--perms', '000', '--tmpfs', path, '--remount-ro', path)
    else args.push('--ro-bind', '/dev/null', path)
  }
  return args
}

/**
 * Describe native input protection and names that require host validation.
 * @param policy - Resolved policy whose inputs the profile protects.
 * @param runner - Native profile dialect selected for this execution.
 * @param privateTempRoots - Existing private temporary capabilities for the Windows session.
 * @returns One record per input, including every unrepresentable name.
 */
export function protectedInputRecords(policy: SandboxPolicy, runner: 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl', privateTempRoots: readonly string[] = []): ProtectedInputEnforcement[] {
  return (policy.protectedPaths ?? []).map((input) => {
    const path = resolve(input)
    if (policy.mode === 'read-only' || runner === 'landlock' || runner === 'seatbelt') return { path, enforcement: 'native' }
    // Neither backend grants the ambient temporary root to the child.
    const roots = [canonicalPath(policy.workspaceRoot), ...runner === 'windows-acl' ? privateTempRoots.map(canonicalPath) : []]
    if (!roots.some(root => contains(root, path))) {
      let target: string
      try { target = canonicalPath(path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === undefined) throw error
        return { path, enforcement: 'host-fallback', reason: 'unrepresentable' }
      }
      if (!roots.some(root => contains(root, target))) return { path, enforcement: 'native' }
    }
    const canonical = mountPath(path)
    if (canonical === undefined || !existsSync(path)) return { path, enforcement: 'host-fallback', reason: 'unrepresentable' }
    if (canonical !== path) return { path, enforcement: 'host-fallback', reason: 'link-name' }
    return { path, enforcement: 'native' }
  })
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const owners = ownerDirectories(policy).map(canonicalPath)
  const readOnly: string[] = []
  const visit = (path: string): void => {
    const canonical = canonicalPath(path)
    if (owners.some(owner => contains(owner, canonical))) return
    if (!owners.some(owner => contains(canonical, owner))) {
      readOnly.push(canonical)
      return
    }
    for (const entry of readdirSync(canonical, { withFileTypes: true })) {
      // Symlink targets receive their own grants; granting aliases can reopen a private ancestor.
      if (!entry.isSymbolicLink()) visit(join(canonical, entry.name))
    }
  }
  try { visit('/') } catch (error) {
    throw new SandboxUnavailableError(policy.mode,
      'Cannot enumerate readable siblings of the private directory. / 无法枚举私密目录的可读兄弟项。'
      + (error instanceof Error ? ` ${error.name}` : ''))
  }
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    // Landlock grants are additive: omit shared temp rather than denying an unrelated workspace.
    if (![...policy.protectedPaths ?? [], ...owners].some(path => rootsOverlap('/tmp', path))) readWrite.push('/tmp')
    readWrite.push(policy.workspaceRoot)
    assertUnprotectedRoots(readWrite, policy.protectedPaths)
  }
  return landlockGrantArgs({ readOnly: [...new Set(readOnly)], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy.
 * Shared temporary roots overlapping host inputs are omitted. Protected inputs
 * deny writes, and their ancestors deny unlink without denying sibling writes.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const workspace = canonicalPath(policy.workspaceRoot)
  const roots = writableRoots(policy).filter(
    root => root === workspace || !(policy.protectedPaths ?? []).some(path => rootsOverlap(root, path)),
  )
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  const paths = [...new Set((policy.protectedPaths ?? []).flatMap(path => [resolve(path), canonicalPath(path)]))]
  for (const path of paths) {
    forms.push(`(deny file-write* (subpath ${sbplString(path)}))`)
  }
  for (const parent of new Set(paths.flatMap(path => protectedParents(workspace, path)))) {
    forms.push(`(deny file-write-unlink (literal ${sbplString(parent)}))`)
  }
  for (const path of ownerDirectories(policy)) {
    forms.push(`(deny file-read* (subpath ${sbplString(path)}))`)
    forms.push(`(deny file-write* (subpath ${sbplString(path)}))`)
  }
  return ['-p', forms.join(' ')]
}
