/** Credential-free failure records use fixed summaries and machine error codes only. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@panedesk/dsh-home-paths'

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
 * @returns The exact line sent to stderr and appended to the home log.
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
    mkdirSync(directory, { recursive: true })
    appendFileSync(join(directory, 'host-errors.log'), line, 'utf8')
  } catch (failure) {
    void failure
    stderr('error host-log-unavailable: Could not append the private host error log.\n')
  }
  return line
}
