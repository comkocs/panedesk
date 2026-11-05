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

import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
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
 * Test whether two recursive filesystem roots share any writable path.
 * @param left - First file or directory root.
 * @param right - Second file or directory root.
 * @returns Whether either canonical root contains the other.
 */
export function rootsOverlap(left: string, right: string): boolean {
  const contains = (root: string, path: string): boolean => {
    const suffix = relative(canonicalPath(root), canonicalPath(path))
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }
  return contains(left, right) || contains(right, left)
}

const homeDiagnosticFiles = new Set(['run/kernel-boot.json', 'run/kernel-status.json', 'logs/host-errors.log'])
const homeAuthorityTrees = ['ledger', 'sessions', 'storages/session_projcache/sessions'] as const

/**
 * List authoritative host trees whose mutable contents are not input baselines.
 * Their native sandbox write exclusions remain unchanged.
 * @param home - Canonical product-home directory.
 * @returns Exact tree roots requiring structural checks on Linux and macOS.
 */
export function authoritativeHomeTrees(home: string): readonly string[] {
  return homeAuthorityTrees.map(path => join(home, path))
}

/**
 * Identify diagnostic-only regular files omitted from a product-home input snapshot.
 * Sandbox write exclusions still protect their entire registered home branch.
 * @param home - Canonical product-home directory whose inputs are being captured.
 * @param path - Physical entry being visited; links and directories remain protected.
 * @returns Whether the entry is an exact diagnostic file without a redirected path.
 */
export function isHomeDiagnosticFile(home: string, path: string): boolean {
  if (!homeDiagnosticFiles.has(relative(home, path).split(sep).join('/'))) return false
  try { return lstatSync(path).isFile() && realpathSync(path) === path } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Refuse a broad native grant that could cover a current host input.
 * @param roots - Directories the backend would grant recursively.
 * @param protectedPaths - Current executable-input roots; absent means none were registered.
 */
export function assertUnprotectedRoots(roots: readonly string[], protectedPaths: readonly string[] = []): void {
  for (const root of roots) for (const path of protectedPaths) {
    if (rootsOverlap(root, path)) {
      throw new Error(`Cannot grant sandbox writes across protected host path ${JSON.stringify(path)}`)
    }
  }
}

/**
 * Protect the first workspace child leading to any private or state directory.
 * @param workspace - Canonical workspace root.
 * @param paths - The shared private/state inventory, prepared by the host.
 * @returns Distinct first children; paths outside the workspace do not add exclusions.
 */
export function protectedWorkspaceBranches(workspace: string, paths: readonly string[]): string[] {
  const root = canonicalPath(workspace)
  return [...new Set(paths.flatMap((path) => {
    const suffix = relative(root, canonicalPath(path))
    if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return []
    return [join(root, suffix.split(sep)[0] ?? '')]
  }))]
}

/**
 * Derive canonical writable roots before applying protected-host exclusions.
 * @param policy - Per-call file policy.
 * @returns Workspace and platform temporary roots in workspace-write; otherwise empty.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
