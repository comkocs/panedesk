/** Credential-free failure records use fixed summaries and machine error codes only. */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { inspectWindowsPrivatePath, secureWindowsPrivatePath } from '@panedesk/node-addon-system/windows-private-files'

function windowsLogPath(path: string, privateAcl: boolean): void {
  const value = inspectWindowsPrivatePath(path)
  if (typeof value !== 'object' || value === null || !('reparse' in value) || value.reparse !== false
    || !('parents' in value) || value.parents !== true) throw new Error('Unsafe log path')
  if (!privateAcl) return
  if (!('sid' in value) || typeof value.sid !== 'string' || !('owner' in value) || value.owner !== value.sid
    || !('protected' in value) || value.protected !== true || !('rules' in value)
    || !Array.isArray(value.rules) || value.rules.length !== 1) throw new Error('Unsafe log ACL')
  const rule: unknown = value.rules[0]
  if (typeof rule !== 'object' || rule === null || !('sid' in rule) || rule.sid !== value.sid
    || !('inherited' in rule) || rule.inherited !== false || !('allow' in rule) || rule.allow !== true
    || !('rights' in rule) || rule.rights !== 2032127 || !('propagation' in rule) || rule.propagation !== 0) {
    throw new Error('Unsafe log ACL')
  }
}

/** Explicit sinks keep failure reporting testable without touching the operator's home. */
export interface FailureLogOptions {
  /** Explicit harness-home override; production resolves `PANEDESK_HOME` then `~/.panedesk`. */
  home?: string
  /** Defaults to stderr; receives one credential-free line. */
  stderr?: (line: string) => void
}

/** Append a bounded error record without formatting the untrusted exception message or stack.
 * @param phase - Fixed lifecycle stage.
 * @param error - Failure whose machine code alone may be reported.
 * @param options - Optional harness-home override and stderr sinks; production uses the current process.
 * @returns The exact line sent to stderr and appended to the private home log.
 */
export function reportHostFailure(phase: 'startup' | 'recovery' | 'diagnostic', error: unknown, options: FailureLogOptions = {}): string {
  let code = 'failure'
  if (error instanceof Error && 'code' in error && typeof error.code === 'string'
    && ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EBUSY', 'EIO', 'ECONNREFUSED', 'ETIMEDOUT',
      'poll-failed', 'duplicate-writeback-marker', 'pending-event-limit-reached', 'event-parked'].includes(error.code)) code = error.code
  const line = `error host-${phase}-${code}: Host ${phase} failed; inspect the configured service and durable state.\n`
  const sink = options.stderr ?? ((value) => { process.stderr.write(value) })
  const stderr = (value: string): void => {
    try { sink(value) }
    catch (failure) { void failure /* Reporting must not replace the original lifecycle error. */ }
  }
  stderr(line)
  const home = resolveDshHome(options.home)
  const directory = join(home, 'logs')
  try {
    for (const path of [dirname(directory), directory]) {
      let created = false
      try { mkdirSync(path, { mode: 0o700 }); created = true }
      catch (failure) {
        if (!(failure instanceof Error) || !('code' in failure) || failure.code !== 'EEXIST') throw failure
      }
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe log directory')
      if (process.platform === 'win32') {
        if (created) secureWindowsPrivatePath(path)
        windowsLogPath(path, path === directory)
      } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
        || (path === directory && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe log permissions')
    }
    const path = join(directory, 'host-errors.log')
    let fd: number
    let created = false
    try { fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600); created = true }
    catch (failure) {
      if (!(failure instanceof Error) || !('code' in failure) || failure.code !== 'EEXIST') throw failure
      if (process.platform === 'win32') windowsLogPath(path, true)
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND
        | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    }
    try {
      if (process.platform === 'win32') {
        if (created) secureWindowsPrivatePath(path)
        windowsLogPath(path, true)
      }
      const opened = fstatSync(fd), named = lstatSync(path)
      if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
        || named.dev !== opened.dev || named.ino !== opened.ino || (process.platform !== 'win32'
        && (opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0))) throw new Error('Unsafe log file')
      appendFileSync(fd, line, 'utf8')
    } finally { closeSync(fd) }
  } catch (failure) {
    void failure
    stderr('error host-log-unavailable: Could not append the private host error log.\n')
  }
  return line
}
