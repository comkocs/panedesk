/** Worker-owned stages inherit in the destination directory and publish through retained handles. */
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { FsError } from '@panedesk/dsh-fs'
import { checkWindowsComponent, refuseWindowsWrite } from './directory-win32.ts'
import type { HandleReply, HandleWriteRequest, WindowsWriteHandler } from './win32-handle-types.ts'
import type { ReplacementPreparation, WindowsWriteApi } from './win32-write-abi.ts'

type Stage = {
  file: number
  parent: number
  name: string
  replacement: ReplacementPreparation | undefined
  phase: 'secured' | 'writing' | 'flushed' | 'ready' | 'committed' | 'failed'
}

/** One synchronous owner processes mutation messages; shutdown discards all uncommitted stages.
 * @param api - Worker-local native operations; replacement requires captured security and metadata.
 * @returns Dispatcher with private stage tokens independent of native file tokens.
 */
export function createStageHandler(api: WindowsWriteApi): WindowsWriteHandler {
  const stages = new Map<number, Stage>()
  let sequence = 0
  let closed = false
  const get = (token: number) => {
    const stage = stages.get(token)
    if (!stage) throw new FsError('Unknown or closed stage / 暂存已关闭或不属于此所有者', 'FS_IO_ERROR')
    return stage
  }
  const cleanup = (token: number) => {
    const stage = get(token)
    stages.delete(token)
    const errors: unknown[] = []
    // A rename moved the staging name itself: disposition would delete the published file.
    if (!(stage.replacement && stage.phase === 'committed')) {
      try { api.disposition(stage.file) } catch (error) { errors.push(error) }
    }
    try { api.close(stage.file) } catch (error) { errors.push(error) }
    try { stage.replacement?.close() } catch (error) { errors.push(error) }
    if (errors.length && stage.phase !== 'committed') throw new AggregateError(errors, 'Stage cleanup failed / 暂存清理失败')
  }
  const execute = (request: HandleWriteRequest): HandleReply => {
    if (closed) throw new FsError('Write owner is closed', 'FS_IO_ERROR')
    switch (request.kind) {
      case 'create-directory': return api.createDirectory(request.parent, checkWindowsComponent(request.name), false, null)
      case 'stage': {
        const name = checkWindowsComponent(request.name)
        const replacement = request.policy.kind === 'replace' ? api.prepareReplacement(request.parent, name, request.policy.observed) : undefined
        let file: number | undefined
        try {
          // A null descriptor lets Windows inherit permissions and integrity labels from the destination folder.
          file = api.createFile(request.parent, `.stage-${randomUUID()}`, null)
          const token = ++sequence
          stages.set(token, { file, parent: request.parent, name, replacement, phase: 'secured' })
          return { kind: 'staged', token }
        } catch (error) {
          const errors: unknown[] = [error]
          if (file !== undefined) {
            try { api.disposition(file) } catch (failure) { errors.push(failure) }
            try { api.close(file) } catch (failure) { errors.push(failure) }
          }
          try { replacement?.close() } catch (failure) { errors.push(failure) }
          if (errors.length > 1) throw new AggregateError(errors, 'Stage preparation and cleanup failed')
          if (error instanceof FsError && error.code === 'FS_PERMISSION_DENIED' && error.message.startsWith('File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试: ')) {
            throw new FsError(`File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试: ${win32.join(api.inspect(request.parent).identity.path, name)}`, 'FS_PERMISSION_DENIED', { cause: error })
          }
          throw error
        }
      }
      case 'remove': {
        const token = api.openRemoval(request.parent, checkWindowsComponent(request.name), request.type)
        let failure: Error | undefined
        try { api.disposition(token) } catch (error) {
          failure = error instanceof Error ? error : new FsError('Removal failed', 'FS_IO_ERROR', { cause: error })
        }
        try { api.close(token) } catch (error) {
          if (failure) throw new AggregateError([failure, error], 'Removal and close failed')
          throw error
        }
        if (failure) throw failure
        return { kind: 'completed' }
      }
      case 'stage-close': case 'discard':
        if (stages.has(request.token)) cleanup(request.token)
        return { kind: 'completed' }
      default: {
        const stage = get(request.token)
        if (stage.phase === 'committed' || stage.phase === 'failed') throw new FsError('Stage is no longer mutable', 'FS_IO_ERROR')
        if (request.kind === 'publish' && (request.request.kind === 'create-or-replace'
          || (request.request.kind === 'replace') !== Boolean(stage.replacement))) return refuseWindowsWrite()
        try {
          switch (request.kind) {
            case 'stage-inspect': return { kind: 'metadata', metadata: api.inspect(stage.file) }
            case 'stage-read': return { kind: 'bytes', bytes: api.read(stage.file, request.position, request.length) }
            case 'write': {
              stage.phase = 'writing'
              const bytes = api.write(stage.file, request.bytes, request.position)
              if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > request.bytes.length || (request.bytes.length > 0 && bytes === 0)) {
                throw new FsError('Write made no valid progress / 写入没有有效进展', 'FS_IO_ERROR')
              }
              return { kind: 'written', bytes }
            }
            case 'flush':
              api.flush(stage.file); stage.phase = 'flushed'
              return { kind: 'completed' }
            case 'prepare-metadata':
              if (stage.phase !== 'flushed') throw new FsError('Flush is required before metadata preparation', 'FS_IO_ERROR')
              // Permissions are established at creation; metadata must complete before publication.
              stage.replacement?.prepare(stage.file)
              stage.phase = 'ready'
              return { kind: 'completed' }
            case 'publish': {
              if (stage.phase !== 'ready') throw new FsError('Stage is not ready for publication', 'FS_IO_ERROR')
              if (stage.replacement) api.replace(stage.file, stage.parent, stage.name)
              else api.link(stage.file, stage.parent, stage.name)
              stage.phase = 'committed'
              // Metadata failure cannot undo a completed link; callers may probe the retained target.
              let metadata = null
              try { metadata = api.inspect(stage.file) } catch (_committedInspectionFailure) {
                // The committed result permits unknown metadata.
              }
              return { kind: 'published', result: { committed: true, metadata } }
            }
          }
        } catch (error) { stage.phase = 'failed'; throw error }
      }
    }
  }
  return {
    execute,
    close() {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      for (const token of stages.keys()) {
        try { cleanup(token) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Write owner cleanup failed')
    },
  }
}
