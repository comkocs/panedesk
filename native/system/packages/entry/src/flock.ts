/** Handle-owned lock files and lazy POSIX flock; imports do not load a native addon. */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { getSystemErrorName } from 'node:util'

interface FlockBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
}

/** Platform and file-open injection for exercising Windows acquisition on other hosts. */
export interface LockFileOptions {
  /** Defaults to the current process platform. */
  platform?: NodeJS.Platform
  /** Defaults to Node's asynchronous file open. */
  open?: typeof open
  /** Windows contention budget in milliseconds; defaults to a short 100 ms window. */
  timeoutMs?: number
  /** Initial Windows backoff in milliseconds; defaults to 10 ms and grows to 40 ms. */
  retryMs?: number
}

/**
 * Acquire a dedicated lock file; close the returned handle to release it.
 * POSIX attempts flock once. Windows retries transient sharing failures within a bounded budget.
 * Windows denies all sharing through libuv's UV_FS_O_EXLOCK; POSIX uses flock.
 * Never pass a data file: Windows also excludes ordinary readers of the locked file.
 * The stable lock file must not be removed or replaced while owners may use it.
 * @param path - Dedicated lock file in a caller-validated private directory.
 * @param options - Platform and open implementation; omitted for production calls.
 * @returns Caller-owned handle, or rejection with EAGAIN/EWOULDBLOCK on contention.
 */
export async function acquireExclusiveLockFile(path: string, options: LockFileOptions = {}): Promise<FileHandle> {
  const windows = (options.platform ?? process.platform) === 'win32'
  const flags = constants.O_CREAT | constants.O_RDWR | (windows ? 0x10000000 : constants.O_NOFOLLOW)
  const deadline = performance.now() + (options.timeoutMs ?? 100)
  let delay = options.retryMs ?? 10
  let handle: FileHandle
  while (true) {
    try {
      handle = await (options.open ?? open)(path, flags, 0o600)
      break
    } catch (error) {
      if (!windows || !(error instanceof Error) || !('code' in error)
        || (error.code !== 'EBUSY' && error.code !== 'EPERM')) throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw Object.assign(new Error(`EAGAIN: exclusive lock file ${basename(win32.basename(path))} is unavailable`), {
          code: 'EAGAIN', syscall: 'open',
        })
      }
      await setTimeout(Math.min(remaining, delay))
      delay = Math.min(delay * 2, 40)
    }
  }
  if (windows) return handle
  try {
    await tryLockExclusive(handle.fd)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

let binding: FlockBinding | undefined

function loadBinding(): FlockBinding {
  if (binding) return binding
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }

  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@panedesk/node-addon-system-${platform}-${arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
  return binding
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const errno = await new Promise<number>((resolve) => {
    loadBinding().tryLock(fd, resolve)
  })
  if (errno === 0) return
  const code = getSystemErrorName(-errno)
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  })
}
