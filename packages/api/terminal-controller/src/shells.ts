/** Shell selection and executable verification use the target execution provider. */
import { resolveWindowsBashDefault } from '@panedesk/dsh-bash-local'
import type { SubprocessTerminalEnvironment, SubprocessRuntime } from '@panedesk/dsh-subprocess'
import type { TerminalShell } from './types.ts'

/**
 * Resolve the configured shell or the execution environment's default shell.
 * On Windows the default is a committed or probed Git Bash selection before
 * the environment's own default (`ComSpec` / `cmd.exe`).
 * @param subprocess - target execution provider.
 * @param configured - optional profile overriding the environment's default shell.
 * @param signal - resolution cancellation.
 * @returns one verified shell; a declared default that cannot resolve rejects.
 */
export async function resolveShell(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined, signal: AbortSignal,
): Promise<TerminalShell> {
  let shell = configured
  if (shell === undefined) {
    const environment = await subprocess.terminalEnvironment(signal)
    shell = profile(defaultShellPath(environment))
  }
  const path = await subprocess.resolveExecutable(shell.path, undefined, signal)
  return { ...shell, path }
}

/**
 * The environment's default shell path, with the Windows Git Bash selection
 * ahead of `ComSpec` while nothing overrode it.
 * @param environment - target execution environment facts.
 * @returns the executable path to run as the default shell.
 */
function defaultShellPath(environment: SubprocessTerminalEnvironment): string {
  if (environment.platform !== 'windows') return environment.defaultShell ?? '/bin/sh'
  return resolveWindowsBashDefault()?.bashPath ?? environment.defaultShell ?? 'cmd.exe'
}

function profile(path: string): TerminalShell {
  const kind = shellKind(path)
  return { path, name: executableName(path), args: kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo'] : ['-i'] }
}

function executableName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

function shellKind(path: string): string {
  return executableName(path).toLowerCase().replace(/\.exe$/u, '')
}

/**
 * List verified candidates after the configured or environment-default shell, one per executable name ignoring case and `.exe`.
 * PATH lookup can reach the default through another directory, such as `/usr/bin/bash` for `/bin/bash` on merged-`/usr` systems.
 * @param subprocess - target execution provider.
 * @param configured - optional default profile.
 * @param candidates - executable names or paths permitted for shell selection.
 * @param signal - discovery cancellation.
 * @returns installed shells with the default first, keeping the earliest entry per name; transport failures reject.
 */
export async function discoverShells(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined,
  candidates: readonly string[], signal: AbortSignal,
): Promise<TerminalShell[]> {
  const preferred = await resolveShell(subprocess, configured, signal)
  const found = await Promise.all(candidates.map(async (candidate) => {
    try { return await resolveShell(subprocess, profile(candidate), signal) }
    catch (error) {
      if (typeof error === 'object' && error !== null
        && 'name' in error && error.name === 'SubprocessExecutableNotFoundError') return undefined
      throw error
    }
  }))
  const shells = new Map<string, TerminalShell>()
  for (const shell of [preferred, ...found]) {
    if (shell === undefined) continue
    const kind = shellKind(shell.path)
    if (!shells.has(kind)) shells.set(kind, shell)
  }
  return [...shells.values()]
}
