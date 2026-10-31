/** Native advisory writer locks retain a stable inode and never steal a live owner's lock. */
import { constants, readFileSync, writeSync } from 'node:fs'
import { open, stat, readFile, type FileHandle } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { acquireExclusiveLockFile, tryLockExclusive } from '@panedesk/node-addon-system/flock'

/** Bounded contention policy; the timeout never authorizes lock theft. */
export interface WriterLockOptions {
  lockTimeoutMs: number
  lockRetryMs: number
}

/** Verified diagnostic observation, never authority to release another writer's lock. */
export interface LedgerLockHolder {
  pid: number
  acquiredAt: number
  heldMs: number
}

function processStart(text: string): string | undefined {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  return ['Z', 'X', 'x'].includes(fields[0] ?? '') ? undefined : fields[19]
}

function publishHolder(handle: FileHandle): void {
  const acquiredAt = Date.now()
  let startIdentity: string | undefined
  let bootIdentity: string | undefined
  try {
    if (process.platform === 'linux') {
      startIdentity = processStart(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
      bootIdentity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    }
    const bytes = Buffer.alloc(512, ' ')
    bytes.write(JSON.stringify({ pid: process.pid, acquiredAt, startIdentity, bootIdentity }))
    // Diagnostics are not journal facts: no extra fsync or durable acknowledgement is needed.
    writeSync(handle.fd, bytes, 0, bytes.length, 0)
  } catch (_error) { /* An unavailable diagnostic never changes lock ownership or write admission. */ }
}

async function holderAt(handle: FileHandle): Promise<LedgerLockHolder | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const bytes = Buffer.alloc(512)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').trim())
    if (!value || typeof value !== 'object' || !('pid' in value) || !('acquiredAt' in value)
      || !('startIdentity' in value) || !('bootIdentity' in value)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.acquiredAt !== 'number' || !Number.isFinite(value.acquiredAt)
      || typeof value.startIdentity !== 'string' || typeof value.bootIdentity !== 'string') return undefined
    const start = processStart(await readFile(`/proc/${value.pid}/stat`, 'utf8'))
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    if (!start || !boot || start !== value.startIdentity || boot !== value.bootIdentity || value.acquiredAt > Date.now()) return undefined
    const info = await handle.stat({ bigint: true })
    const major = (info.dev >> 8n & 0xfffn) | (info.dev >> 32n & 0xfffff000n)
    const minor = (info.dev & 0xffn) | (info.dev >> 12n & 0xffffff00n)
    const locks = await readFile('/proc/locks', 'utf8')
    const owns = locks.split('\n').some((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || fields[4] !== String(value.pid)) return false
      const [deviceMajor, deviceMinor, inode] = (fields[5] ?? '').split(':')
      return deviceMajor !== undefined && deviceMinor !== undefined && inode !== undefined
        && BigInt(`0x${deviceMajor}`) === major && BigInt(`0x${deviceMinor}`) === minor && BigInt(inode) === info.ino
    })
    if (!owns) return undefined
    const current = Buffer.alloc(512)
    const reread = await handle.read(current, 0, current.length, 0)
    if (reread.bytesRead !== bytesRead || !current.equals(bytes)) return undefined
    return { pid: value.pid, acquiredAt: value.acquiredAt, heldMs: Date.now() - value.acquiredAt }
  } catch (_error) { return undefined /* Missing, torn or stale metadata is not a holder observation. */ }
}

function clearHolder(handle: FileHandle): void {
  try { writeSync(handle.fd, Buffer.alloc(512, ' '), 0, 512, 0) }
  catch (_error) { /* The descriptor is still closed even when diagnostic cleanup fails. */ }
}

/** Local accounting failures stop dependent dispatch; callers may retry only with the same fact identity. */
export class LedgerUnavailableError extends Error {
  /** Stable failure code for callers that must stop dependent dispatch. */
  readonly code = 'LEDGER_UNAVAILABLE'
  /** Present only when contention expires before the transaction starts; wrappers preserve it. */
  readonly lockTimeoutCode?: 'LEDGER_LOCK_TIMEOUT'
  /** Verified holder observation when the platform permits reading locked metadata. */
  readonly lockHolder?: LedgerLockHolder
  constructor(cause: unknown, holder?: LedgerLockHolder) {
    super('Local accounting is unavailable; dispatch was stopped. Inspect the ledger before retrying.', { cause })
    this.name = 'LedgerUnavailableError'
    const observed = holder ?? (cause instanceof LedgerUnavailableError ? cause.lockHolder : undefined)
    if (observed) {
      this.lockHolder = observed
      this.message += ` Lock holder PID ${observed.pid}, held for ${observed.heldMs} ms.`
    }
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
    publishHolder(handle)
    try { return await operation() } finally { clearHolder(handle); await handle.close() }
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
        if (remaining <= 0) throw new LedgerUnavailableError(error, await holderAt(handle))
        await setTimeout(Math.min(remaining, options.lockRetryMs))
      }
    }
    const held = await handle.stat({ bigint: true })
    const named = await stat(path, { bigint: true })
    if (held.ino !== named.ino || held.dev !== named.dev) throw new LedgerUnavailableError(new Error('Writer lock inode changed'))
    publishHolder(handle)
    try { return await operation() } finally { clearHolder(handle) }
  } finally {
    await handle.close()
  }
}
