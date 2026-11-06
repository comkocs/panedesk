/** Serial worker ownership keeps synchronous Win32 I/O off the service event loop. */
import { FsError } from '@panedesk/dsh-fs'
import type { HandleExecutor, HandleReply, HandleRequest } from './win32-handle-types.ts'

/** Create an operation-owned executor; shutdown waits for all queued calls and worker exit.
 * @returns A private serialized channel with no native handles exposed.
 */
export function createHandleExecutor(): HandleExecutor {
  let closing: Promise<void> | undefined
  let sequence = 0
  let tail: Promise<unknown> = Promise.resolve()
  const pending = new Map<number, { resolve: (reply: HandleReply) => void; reject: (error: Error) => void }>()
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure = error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  const started = import('node:worker_threads').then(({ Worker }) => {
    const source = import.meta.url.endsWith('.ts')
    const worker = new Worker(new URL(source ? './win32-handle-worker.ts' : './win32-handle-worker.js', import.meta.url))
    worker.on('message', (message: { id: number; reply?: HandleReply; error?: { message: string; code: string } }) => {
      const waiter = pending.get(message.id)
      if (!waiter) { fail(new FsError('Invalid handle worker sequence', 'FS_IO_ERROR')); return }
      pending.delete(message.id)
      if (message.error) {
        const { code } = message.error
        waiter.reject(code === 'ENOENT'
          ? Object.assign(new Error(message.error.message), { code })
          : new FsError(message.error.message, code === 'FS_SANDBOX_DENIED' ? code : code === 'FS_PERMISSION_DENIED' ? code : 'FS_IO_ERROR'))
      } else if (message.reply) waiter.resolve(message.reply)
      else waiter.reject(new FsError('Invalid handle worker reply', 'FS_IO_ERROR'))
    })
    worker.on('error', fail)
    const exited = new Promise<void>((resolve, reject) => {
      worker.once('exit', (code) => {
        if (pending.size || !closing || code !== 0) {
          const error = new FsError(`Handle worker exited unexpectedly (${code})`, 'FS_IO_ERROR')
          fail(error)
          reject(error)
        } else resolve()
      })
    })
    // Retain the exit failure for close without producing an unhandled rejection.
    void exited.catch(() => undefined)
    return { worker, exited }
  }).catch((error: unknown) => {
    const wrapped = new FsError('Windows handle executor unavailable / Windows 句柄执行器不可用', 'FS_IO_ERROR', { cause: error })
    fail(wrapped)
    throw wrapped
  })
  void started.catch(() => undefined)

  const send = async (request: HandleRequest): Promise<HandleReply> => {
    const { worker } = await started
    if (failure) throw failure
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { worker.postMessage({ id, request }) } catch (error) {
        pending.delete(id)
        reject(new FsError('Cannot send handle operation', 'FS_IO_ERROR', { cause: error }))
      }
    })
  }
  return {
    execute(request) {
      if (closing) return Promise.reject(new FsError('Handle executor is closing', 'FS_IO_ERROR'))
      const result = tail.then(() => send(request))
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    close() {
      return closing ??= (async () => {
        await tail
        const { exited } = await started
        try {
          if (!failure) await send({ kind: 'shutdown' })
        } finally { await exited }
      })()
    },
  }
}
