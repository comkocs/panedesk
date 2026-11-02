/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @panedesk/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@panedesk/node-addon-system/landlock-run'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { assertUnprotectedRoots, canonicalPath, rootsOverlap, writableRoots } from '@panedesk/dsh-sandbox'
import type { SandboxPolicy } from '@panedesk/dsh-sandbox'

/** Test containment after callers have canonicalized both paths. */
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
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

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    const temporary = !(policy.protectedPaths ?? []).some(path => rootsOverlap('/tmp', path))
    if (temporary) args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    const paths = [...new Set((policy.protectedPaths ?? []).flatMap(path => [resolve(path), canonicalPath(path)]))]
    const parents = [...new Set(paths.flatMap(path => protectedParents(policy.workspaceRoot, path)))].sort((a, b) => a.length - b.length)
    for (const parent of parents) {
      // A mount point cannot be renamed or unlinked, but its ordinary children remain writable.
      if (existsSync(parent)) args.push('--bind', parent, parent)
      else args.push('--tmpfs', parent)
    }
    for (const path of paths) {
      if (existsSync(path)) args.push('--ro-bind', canonicalPath(path), path)
      else if (contains(policy.workspaceRoot, path)) args.push('--tmpfs', path, '--remount-ro', path)
    }
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    // Landlock grants are additive: omit shared temp rather than denying an unrelated workspace.
    if (!(policy.protectedPaths ?? []).some(path => rootsOverlap('/tmp', path))) readWrite.push('/tmp')
    readWrite.push(policy.workspaceRoot)
    assertUnprotectedRoots(readWrite, policy.protectedPaths)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
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
  return ['-p', forms.join(' ')]
}
