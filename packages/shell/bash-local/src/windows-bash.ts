/** Windows Git Bash discovery and the product-level enablement the base profiles gate on. */

import { existsSync, type PathLike, readFileSync, type WriteFileOptions } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { resolveDshHome } from '@panedesk/dsh-home-paths'

/** Filesystem surface {@link readWindowsBashConfig} and {@link probeWindowsBash} accept for tests. */
export interface WindowsBashFs {
  /** Whether a path exists, as `node:fs` `existsSync`. */
  existsSync: (path: PathLike) => boolean
  /** UTF-8 file read, as `node:fs` `readFileSync`. */
  readFileSync: (path: PathLike, options: 'utf8') => string
}

/** Filesystem surface {@link writeWindowsBashConfig} accepts for tests. */
export interface WindowsBashWriteFs {
  /** Synchronous write used by the test seam; the product path writes atomically. */
  writeFileSync: (path: PathLike, data: string, options: WriteFileOptions) => void
}

/**
 * Product-level Windows Bash selection written after the user confirms the
 * one-click setup. Base profiles stay on the PowerShell default until this
 * file enables the Bash rows, so `enabled: true` with a usable `bashPath` is
 * the only committed state; clearing the file restores the default.
 */
export interface WindowsBashConfig {
  /** Whether the Windows product runs the Bash rows instead of the PowerShell rows. */
  readonly enabled: boolean
  /** Absolute path of the Bash executable passed to the executor as `bashPath`. */
  readonly bashPath: string
}

/** Filename of the product config under the DeepSeek Harness home. */
export const WINDOWS_BASH_CONFIG_FILENAME = 'windows-bash.json'

/**
 * Absolute path of the Windows Bash product config. Resolves the same home as
 * every other harness user file, so the Loader expression reading it and the
 * settings row writing it agree on one location.
 * @param env Environment mapping used to read `PANEDESK_HOME`.
 * @returns Absolute path of `windows-bash.json` under the resolved harness home.
 */
export function windowsBashConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), WINDOWS_BASH_CONFIG_FILENAME)
}

/**
 * Parse one candidate config document. Unknown fields are ignored so a newer
 * product can extend the file; any shape the Bash gating could not act on is
 * absent, never a partial value.
 * @param text File contents as read from disk.
 * @returns The config, or undefined when the document does not carry an enabled selection.
 */
export function parseWindowsBashConfig(text: string): WindowsBashConfig | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { enabled, bashPath } = parsed as Record<string, unknown>
  if (enabled !== true || typeof bashPath !== 'string' || bashPath.length === 0) return undefined
  return { enabled, bashPath }
}

/**
 * Read the product config. The Bash and PowerShell gating runs on this value,
 * so a missing, unreadable, or invalid file reads as absent and keeps the
 * platform default; it never throws.
 * @param fs Filesystem seam; defaults to `node:fs`.
 * @param env Environment mapping used to locate the harness home.
 * @returns The committed selection, or undefined when no usable selection exists.
 */
export function readWindowsBashConfig(
  fs: WindowsBashFs = { existsSync, readFileSync },
  env: Record<string, string | undefined> = process.env,
): WindowsBashConfig | undefined {
  const path = windowsBashConfigPath(env)
  if (!fs.existsSync(path)) return undefined
  try {
    return parseWindowsBashConfig(fs.readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Commit one selection as the product config. The caller owns the user
 * confirmation; this write is the committed effect of that confirmation.
 * @param config Selection to store; `enabled: true` requires a nonempty `bashPath`.
 * @param fs Explicit write seam for tests; omitted writes with the atomic writer.
 * @param env Environment mapping used to locate the harness home.
 * @throws When `config` is not a value {@link parseWindowsBashConfig} would return.
 */
export async function writeWindowsBashConfig(
  config: WindowsBashConfig,
  fs?: WindowsBashWriteFs,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!config.enabled || typeof config.bashPath !== 'string' || config.bashPath.length === 0) {
    throw new Error('windows-bash: config must carry enabled true and a nonempty bashPath')
  }
  const path = windowsBashConfigPath(env)
  const document = JSON.stringify({ enabled: config.enabled, bashPath: config.bashPath }, undefined, 2) + '\n'
  if (fs !== undefined) {
    fs.writeFileSync(path, document, 'utf8')
    return
  }
  await writeFileAtomic(path, document, { mode: 0o600 })
}

/**
 * Remove the product config, restoring the platform default (PowerShell on
 * Windows). This is the committed effect of the settings row's disable action.
 * @param env Environment mapping used to locate the harness home.
 */
export async function clearWindowsBashConfig(env: Record<string, string | undefined> = process.env): Promise<void> {
  await rm(windowsBashConfigPath(env), { force: true })
}

/** Where one candidate executable was found, shown next to the detected path. */
export type WindowsBashSource =
  | 'program-files'
  | 'program-files-x86'
  | 'user-programs'
  | 'user-git'
  | 'scoop'
  | 'scoop-shim'
  | 'portable'

/** One probed install location. */
export interface WindowsBashCandidate {
  /** Absolute executable path as passed to the executor. */
  readonly bashPath: string
  /** Install family the path belongs to. */
  readonly source: WindowsBashSource
}

/**
 * Ordered candidate Git Bash executables on Windows. Standard installers,
 * per-user installs, Scoop, and unpacked portable distributions cover the
 * locations a first-run probe can name without a registry or package-manager
 * query; entries whose environment anchor is unset are skipped.
 * @param env Environment mapping supplying the Windows profile directories.
 * @returns Candidates in probe order.
 */
export function windowsBashCandidates(env: Record<string, string | undefined> = process.env): WindowsBashCandidate[] {
  const value = (name: string): string | undefined => {
    const direct = env[name]
    if (direct !== undefined && direct.trim() !== '') return direct
    const lowered = name.toLowerCase()
    for (const [key, entry] of Object.entries(env)) {
      if (key.toLowerCase() === lowered && entry !== undefined && entry.trim() !== '') return entry
    }
    return undefined
  }
  const rows: readonly (readonly [WindowsBashSource, string | undefined, readonly string[]])[] = [
    ['program-files', value('ProgramFiles'), ['Git', 'bin', 'bash.exe']],
    ['program-files-x86', value('ProgramFiles(x86)'), ['Git', 'bin', 'bash.exe']],
    ['user-programs', value('LocalAppData'), ['Programs', 'Git', 'bin', 'bash.exe']],
    ['user-git', value('LocalAppData'), ['Git', 'bin', 'bash.exe']],
    ['scoop', value('USERPROFILE'), ['scoop', 'apps', 'git', 'current', 'bin', 'bash.exe']],
    ['scoop-shim', value('USERPROFILE'), ['scoop', 'shims', 'bash.exe']],
    ['portable', value('USERPROFILE'), ['PortableGit', 'bin', 'bash.exe']],
  ]
  // Windows path semantics regardless of the probing host, so candidate text
  // stays stable in tests and on Windows itself.
  return rows.flatMap(([source, anchor, segments]) =>
    anchor === undefined ? [] : [{ bashPath: win32.join(anchor, ...segments), source }])
}

/**
 * Probe the candidate locations in order and return the first executable that
 * exists. Presence is the probe's claim: verifying the binary runs belongs to
 * the confirmation step that writes the config.
 * @param fs Filesystem seam; defaults to `node:fs`.
 * @param env Environment mapping supplying the Windows profile directories.
 * @returns The first existing candidate, or undefined when none is installed.
 */
export function probeWindowsBash(
  fs: Pick<WindowsBashFs, 'existsSync'> = { existsSync },
  env: Record<string, string | undefined> = process.env,
): WindowsBashCandidate | undefined {
  return windowsBashCandidates(env).find(candidate => fs.existsSync(candidate.bashPath))
}
