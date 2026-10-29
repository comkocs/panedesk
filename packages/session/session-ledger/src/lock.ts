/** Native advisory writer locks retain a stable inode and never steal a live owner's lock. */
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { acquireExclusiveLockFile, tryLockExclusive } from '@panedesk/node-addon-system/flock'

/** Bounded contention policy; the timeout never authorizes lock theft. */
export interface WriterLockOptions {
  lockTimeoutMs: number
  lockRetryMs: number
}

/** Local accounting failures stop dependent dispatch; callers may retry only with the same fact identity. */
export class LedgerUnavailableError extends Error {
  /** Stable failure code for callers that must stop dependent dispatch. */
  readonly code = 'LEDGER_UNAVAILABLE'
  /** Present only when contention expires before the transaction starts; wrappers preserve it. */
  readonly lockTimeoutCode?: 'LEDGER_LOCK_TIMEOUT'
  constructor(cause: unknown) {
    super('Local accounting is unavailable; dispatch was stopped. Inspect the ledger before retrying.', { cause })
    this.name = 'LedgerUnavailableError'
    if (cause instanceof Error && 'lockTimeoutCode' in cause && cause.lockTimeoutCode === 'LEDGER_LOCK_TIMEOUT') {
      this.lockTimeoutCode = cause.lockTimeoutCode
    }
  }
}

/** Run one transaction under an exclusive native lock, closing only its own descriptor.
 * @param path - Stable lock-file path in an already created private directory.
 * @param options - Maximum contention wait and retry pacing.
 * @param operation - Operation that must settle before releasing ownership.
 * @returns The operation result; unsupported platforms, contention expiry, and I/O failures reject.
 */
export async function withWriterLock<T>(path: string, options: WriterLockOptions, operation: () => Promise<T>): Promise<T> {
  if (process.platform === 'win32') {
    let handle
    try {
      handle = await acquireExclusiveLockFile(path, { timeoutMs: options.lockTimeoutMs, retryMs: options.lockRetryMs })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EAGAIN') {
        Object.assign(error, { lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' })
      }
      if (error instanceof Error && 'code' in error && error.code === 'EAGAIN') throw new LedgerUnavailableError(error)
      throw error
    }
    try { return await operation() } finally { await handle.close() }
  }
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const deadline = performance.now() + options.lockTimeoutMs
    while (true) {
      try {
        await tryLockExclusive(handle.fd)
        break
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error
        const remaining = deadline - performance.now()
        if (remaining <= 0 && error instanceof Error) Object.assign(error, { lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' })
        if (remaining <= 0) throw new LedgerUnavailableError(error)
        await setTimeout(Math.min(remaining, options.lockRetryMs))
      }
    }
    const held = await handle.stat({ bigint: true })
    const named = await stat(path, { bigint: true })
    if (held.ino !== named.ino || held.dev !== named.dev) throw new LedgerUnavailableError(new Error('Writer lock inode changed'))
    return await operation()
  } finally {
    await handle.close()
  }
}
