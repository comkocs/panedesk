/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @panedesk/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@panedesk/node-addon-system/landlock-run'
import { existsSync } from 'node:fs'
import { assertUnprotectedRoots, canonicalPath, rootsOverlap, writableRoots } from '@panedesk/dsh-sandbox'
import type { SandboxPolicy } from '@panedesk/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    const temporary = !(policy.protectedPaths ?? []).some(path => rootsOverlap('/tmp', path))
    assertUnprotectedRoots([policy.workspaceRoot], policy.protectedPaths)
    if (temporary) args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    for (const input of policy.protectedPaths ?? []) {
      const path = canonicalPath(input)
      if (!existsSync(path)) {
        // A missing input outside writable mounts is already protected by the root mount.
        assertUnprotectedRoots([policy.workspaceRoot, ...temporary ? ['/tmp'] : []], [path])
        continue
      }
      args.push('--ro-bind', path, path)
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
 * Shared temporary roots overlapping host inputs are omitted; an overlapping
 * workspace is rejected before handing a writable profile to the runner.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  if (policy.mode === 'workspace-write') assertUnprotectedRoots([policy.workspaceRoot], policy.protectedPaths)
  const roots = writableRoots(policy).filter(root => !(policy.protectedPaths ?? []).some(path => rootsOverlap(root, path)))
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  for (const path of policy.protectedPaths ?? []) {
    forms.push(`(deny file-write* (subpath ${sbplString(path)}))`)
  }
  return ['-p', forms.join(' ')]
}
