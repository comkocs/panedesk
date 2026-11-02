/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @panedesk/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@panedesk/node-addon-system/landlock-run'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertUnprotectedRoots, rootsOverlap, writableRoots } from '@panedesk/dsh-sandbox'
import type { SandboxPolicy } from '@panedesk/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    for (const path of policy.protectedPaths ?? []) {
      let existing = path
      while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
      args.push('--ro-bind', existing, existing)
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
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@panedesk/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  for (const path of policy.protectedPaths ?? []) {
    forms.push(`(deny file-write* (subpath ${sbplString(path)}))`)
  }
  return ['-p', forms.join(' ')]
}
