/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@panedesk/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@panedesk/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns The nearest existing ancestor's native realpath followed by missing components.
 * @throws When an existing prefix cannot be resolved because of an access or filesystem error.
 */
export function canonicalPath(path: string): string {
  let ancestor = path
  const suffix: string[] = []
  while (true) {
    try {
      // Native lookup preserves filesystem ordering for symlinks followed by `..`.
      return join(realpathSync.native(ancestor), ...suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
/** No workspace branch is excluded.
 * @param _workspace - ignored.
 * @param _paths - ignored.
 * @returns no branches.
 */
export function protectedWorkspaceBranches(_workspace: string, _paths: readonly string[]): string[] {
  return []
}

/** Mutable home trees are not treated as a separate authority inventory.
 * @param _home - ignored.
 * @returns no trees.
 */
export function authoritativeHomeTrees(_home: string): readonly string[] {
  return []
}

/** Diagnostic home files are not special-cased.
 * @param _home - ignored.
 * @param _path - ignored.
 * @returns false.
 */
export function isHomeDiagnosticFile(_home: string, _path: string): boolean {
  return false
}

/** Grants are not refused for overlapping host paths.
 * @param _roots - ignored.
 * @param _protectedPaths - ignored.
 */
export function assertUnprotectedRoots(_roots: readonly string[], _protectedPaths: readonly string[] = []): void {}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
