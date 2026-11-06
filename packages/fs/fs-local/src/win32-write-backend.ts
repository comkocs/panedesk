/** Optional Windows write assembly never consults legacy path hooks. */
import { FsError } from '@panedesk/dsh-fs'
import { checkWindowsComponent, refuseWindowsWrite } from './directory-win32.ts'
import { createWindowsWriteApi } from './win32-write-abi.ts'
import { createStageHandler } from './win32-stage.ts'
import type { OwnedStage } from './directory-handle.ts'
import type { HandleReply, WindowsNativeContext, WindowsWriteExtension, WindowsWriteHandler, WindowsWriteTarget } from './win32-handle-types.ts'

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('File operation aborted / 文件操作已取消', 'FS_ABORTED')
}
function completed(reply: HandleReply): void {
  if (reply.kind !== 'completed') throw new FsError('Invalid mutation reply', 'FS_IO_ERROR')
}
function range(buffer: Buffer, offset: number, length: number, position: bigint): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length
    || position < 0n || position + BigInt(length) > 0x7fffffffffffffffn) throw new FsError('Invalid owned file range', 'FS_IO_ERROR')
}

/** Assemble worker-local ownership without exposing native handles to the calling thread.
 * @param context - Read owner's validated handle table.
 * @returns Mutation handler; unavailable security refuses before staging creates an object.
 */
export function createWindowsWriteHandler(context: WindowsNativeContext): WindowsWriteHandler {
  return createStageHandler(createWindowsWriteApi(context))
}

/** Assemble serialized owned stages for one retained directory target.
 * @param target - Retained tokens and read capabilities, never a pathname for I/O.
 * @returns No-replace write and deletion adapter; overwrite remains unavailable.
 */
export function createWindowsWriteExtension(target: WindowsWriteTarget): WindowsWriteExtension {
  const extension: WindowsWriteExtension = {
    async createDirectory(parent, name) {
      const reply = await target.execute({ kind: 'create-directory', parent, name: checkWindowsComponent(name) })
      if (reply.kind !== 'opened') throw new FsError('Invalid directory creation reply', 'FS_IO_ERROR')
      return reply
    },
    async stage(parent, name, policy, signal) {
      aborted(signal)
      if (policy.kind !== 'new') return refuseWindowsWrite()
      const reply = await target.execute({ kind: 'stage', parent, name: checkWindowsComponent(name), policy })
      if (reply.kind !== 'staged') throw new FsError('Invalid stage creation reply', 'FS_IO_ERROR')
      const token = reply.token
      let tail: Promise<unknown> = Promise.resolve()
      let closing: Promise<void> | undefined
      const run = <T>(operation: () => Promise<T>): Promise<T> => {
        if (closing) return Promise.reject(new FsError('Stage is closed / 暂存已关闭', 'FS_IO_ERROR'))
        const result = tail.then(() => { aborted(signal); return operation() })
        tail = result.then(() => undefined, () => undefined)
        return result
      }
      const close = () => closing ??= (async () => {
        await tail
        const result = await target.execute({ kind: 'stage-close', token })
        completed(result)
      })()
      const stage: OwnedStage = {
        file: {
          inspect: () => run(async () => {
            const result = await target.execute({ kind: 'stage-inspect', token })
            if (result.kind !== 'metadata') throw new FsError('Invalid stage inspection reply', 'FS_IO_ERROR')
            return result.metadata
          }),
          read: (buffer, offset, length, position) => run(async () => {
            range(buffer, offset, length, position)
            const result = await target.execute({ kind: 'stage-read', token, position, length: Math.min(length, 1024 * 1024) })
            if (result.kind !== 'bytes' || result.bytes.length > length) throw new FsError('Invalid stage read reply', 'FS_IO_ERROR')
            buffer.set(result.bytes, offset)
            return result.bytes.length
          }),
          write: (buffer, offset, length, position) => {
            try { range(buffer, offset, length, position) } catch (error) {
              return Promise.reject(error instanceof Error ? error : new FsError('Invalid write range', 'FS_IO_ERROR', { cause: error }))
            }
            // The caller may mutate its buffer while the worker is queued; this operation owns its bytes.
            const bytes = Uint8Array.from(buffer.subarray(offset, offset + Math.min(length, 1024 * 1024)))
            return run(async () => {
              const result = await target.execute({ kind: 'write', token, bytes, position })
              if (result.kind !== 'written' || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > bytes.length
                || (bytes.length > 0 && result.bytes === 0)) throw new FsError('Invalid write progress', 'FS_IO_ERROR')
              return result.bytes
            })
          },
          flush: () => run(async () => { completed(await target.execute({ kind: 'flush', token })) }),
          close,
        },
        prepareMetadata: () => run(async () => { completed(await target.execute({ kind: 'prepare-metadata', token })) }),
        publish: (request, publishSignal) => run(async () => {
          aborted(publishSignal)
          const result = await target.execute({ kind: 'publish', token, request })
          if (result.kind !== 'published') throw new FsError('Invalid publication reply', 'FS_IO_ERROR')
          return result.result
        }),
        discard: close,
        close,
      }
      if (signal?.aborted) { await close(); aborted(signal) }
      return stage
    },
    readForEdit() { return Promise.reject(new FsError('Windows handle replacement not ready / Windows 句柄覆盖尚未就绪', 'FS_IO_ERROR')) },
    readTextForDiff() { return Promise.reject(new FsError('Windows handle replacement not ready / Windows 句柄覆盖尚未就绪', 'FS_IO_ERROR')) },
    async write(content, mode, signal, _internals, createIfAbsent) {
      aborted(signal)
      if (mode !== undefined || target.entry.kind !== 'child') return refuseWindowsWrite()
      const stage = await extension.stage(target.parent, target.entry.name, { kind: 'new', inheritFromDestination: true }, signal)
      let failure: Error | undefined
      let committed = false
      try {
        const buffer = Buffer.from(content, 'utf8')
        let offset = 0
        while (offset < buffer.length) {
          aborted(signal)
          offset += await stage.file.write(buffer, offset, buffer.length - offset, BigInt(offset))
        }
        await stage.file.flush()
        await stage.prepareMetadata()
        await stage.publish({ kind: 'create-if-absent', displayPath: createIfAbsent?.displayPath ?? target.entry.name }, signal)
        committed = true
      } catch (error) {
        failure = error instanceof Error ? error : new FsError('Write failed', 'FS_IO_ERROR', { cause: error })
      }
      try { await stage.close() } catch (error) {
        if (!committed) {
          if (failure) throw new AggregateError([failure, error], 'Write and cleanup failed')
          throw error
        }
      }
      if (failure) throw failure
    },
    async remove() {
      if (target.entry.kind !== 'child') return refuseWindowsWrite()
      completed(await target.execute({ kind: 'remove', parent: target.parent, name: target.entry.name, type: 'file' }))
    },
  }
  return extension
}
