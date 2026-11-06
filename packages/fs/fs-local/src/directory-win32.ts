/** Windows traversal retains every ancestor and rejects all reparse points. */
import { win32 } from 'node:path'
import { FsError, FsTargetKey } from '@panedesk/dsh-fs'
import type { DirectoryBackend, DirectoryCapability, RootRequest } from './directory-handle.ts'
import type { LocalDirEntry, LocalTarget, PathInfo } from './fsio.ts'
import type { ReadHandle } from './read-handle.ts'
import type { HandleExecutor, HandleMetadata, HandleReply } from './win32-handle-types.ts'
import { createHandleExecutor } from './win32-handle-executor.ts'

/** Reject names whose Win32 interpretation can escape a single relative component.
 * @param raw - A user-supplied or enumerated component, without normalization.
 * @returns The unchanged, validated component.
 */
export function checkWindowsComponent(raw: string): string {
  if (!raw || raw === '.' || raw === '..' || /[\x00-\x1f<>:"/\\|?*]/u.test(raw)
    || /[ .]$/u.test(raw) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(raw)
    || !raw.isWellFormed() || Buffer.byteLength(raw, 'utf16le') + 2 > 65535) {
    throw new FsError('Invalid Windows path component / Windows 路径段无效', 'FS_SANDBOX_DENIED')
  }
  return raw
}

/** Refuse mutations until the complete write adapter is available and accepted. */
export function refuseWindowsWrite(): never {
  throw new FsError('Windows handle write capability is not ready; path fallback is forbidden / Windows 句柄写能力尚未就绪，禁止退回路径操作', 'FS_IO_ERROR')
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('File operation aborted / 文件操作已取消', 'FS_ABORTED')
}

function safeMetadata(metadata: HandleMetadata): HandleMetadata {
  if (metadata.attributes & 0x400) throw new FsError('Reparse points are forbidden / 禁止访问重解析点', 'FS_SANDBOX_DENIED')
  return metadata
}

function opened(reply: HandleReply): Extract<HandleReply, { kind: 'opened' }> {
  if (reply.kind !== 'opened') throw new FsError('Invalid handle executor reply', 'FS_IO_ERROR')
  return reply
}

function pathParts(cwd: string, path: string): { path: string; root: string; names: string[] } {
  const absolute = /^[a-z]:[\\/]/iu.test(path) ? path : `${cwd}\\${path}`
  if (!/^[a-z]:[\\/]/iu.test(absolute) || absolute.startsWith('\\\\')) {
    throw new FsError('Only absolute local drive paths are supported / 仅支持本地盘符绝对路径', 'FS_SANDBOX_DENIED')
  }
  const root = `${absolute.slice(0, 2).toUpperCase()}\\`
  const names = absolute.slice(3).split(/[\\/]/u).filter(Boolean).map(checkWindowsComponent)
  return { path: root + names.join('\\'), root, names }
}

/** Parse only complete bounded FILE_DIRECTORY_INFORMATION records.
 * @param bytes - Exactly IOSB.Information bytes, not the entire allocation.
 * @returns Validated direct child names; kernel dot entries are omitted.
 */
export function directoryNames(bytes: Uint8Array): string[] {
  const data = Buffer.from(bytes)
  const names: string[] = []
  let offset = 0
  while (offset < data.length) {
    if (data.length - offset < 64) throw new FsError('Truncated directory information', 'FS_IO_ERROR')
    const next = data.readUInt32LE(offset)
    const length = data.readUInt32LE(offset + 60)
    if (length === 0 || length % 2 !== 0 || length > data.length - offset - 64
      || (next !== 0 && (next % 8 !== 0 || next < 64 + length || next >= data.length - offset))) {
      throw new FsError('Invalid directory information offsets', 'FS_IO_ERROR')
    }
    const name = data.subarray(offset + 64, offset + 64 + length).toString('utf16le')
    if (name !== '.' && name !== '..') names.push(checkWindowsComponent(name))
    if (next === 0) return names
    offset += next
  }
  return names
}

/** Expand incomplete directory buffers without mistaking SUCCESS plus zero bytes for EOF.
 * @param executor - Owner of the directory cursor.
 * @param token - Open directory token; no path is reconstructed.
 * @param signal - Optional cancellation between native calls.
 * @returns All validated names from this non-snapshot scan.
 */
export async function enumerateWindows(executor: HandleExecutor, token: number, signal?: AbortSignal): Promise<string[]> {
  let size = 4096
  let restart = true
  const names: string[] = []
  while (true) {
    aborted(signal)
    const reply = await executor.execute({ kind: 'enumerate', token, size, restart })
    if (reply.kind !== 'directory') throw new FsError('Invalid directory executor reply', 'FS_IO_ERROR')
    if (reply.status === 0x80000006) return names
    if (reply.status === 0x80000005 || reply.status === 0xc0000023 || (reply.status === 0 && reply.bytes.length === 0)) {
      if (size >= 1024 * 1024) throw new FsError('Directory information exceeds supported buffer', 'FS_IO_ERROR')
      size *= 2
      continue
    }
    if (reply.status !== 0) throw new FsError(`Directory query failed (NTSTATUS ${reply.status})`, 'FS_IO_ERROR')
    names.push(...directoryNames(reply.bytes))
    restart = false
  }
}

/** A normal dependency-assembled backend; each target owns a separate worker and ancestor set. */
export class WindowsDirectoryBackend implements DirectoryBackend {
  readonly choice = 'windows-handles'
  constructor(private readonly executor: () => HandleExecutor = createHandleExecutor) {}

  assertWritable(): never { return refuseWindowsWrite() }

  async resolve(cwd: string, path: string, signal?: AbortSignal): Promise<LocalTarget> {
    const parsed = pathParts(cwd, path)
    const executor = this.executor()
    try {
      aborted(signal)
      let parent = opened(await executor.execute({ kind: 'root', path: parsed.root }))
      safeMetadata(parent.metadata)
      let missingFrom = parsed.names.length
      for (const [index, name] of parsed.names.entries()) {
        aborted(signal)
        try {
          parent = opened(await executor.execute({ kind: 'open', parent: parent.token, name, directory: index < parsed.names.length - 1, content: false }))
          safeMetadata(parent.metadata)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { missingFrom = index; break }
          throw error
        }
      }
      const canonical = win32.join(parent.metadata.identity.path, ...parsed.names.slice(missingFrom))
      return { displayPath: parsed.path, targetKey: FsTargetKey(canonical) }
    } finally { await executor.close() }
  }

  async openTarget(path: string, createParents: boolean, root: RootRequest, signal?: AbortSignal): Promise<DirectoryCapability> {
    if (createParents) this.assertWritable()
    const parsed = pathParts('', path)
    const authorized = root.kind === 'filesystem' ? parsed.root : pathParts('', root.displayPath).path
    const suffix = win32.relative(authorized, parsed.path)
    if (suffix === '..' || suffix.startsWith('..\\') || win32.isAbsolute(suffix)) {
      throw new FsError('Cannot access outside the authorized directory', 'FS_SANDBOX_DENIED')
    }
    const executor = this.executor()
    let closed: Promise<void> | undefined
    const close = () => closed ??= executor.close()
    try {
      aborted(signal)
      let parent = opened(await executor.execute({ kind: 'root', path: parsed.root }))
      if (safeMetadata(parent.metadata).type !== 'directory') throw new FsError('Volume root is not a directory', 'FS_IO_ERROR')
      const self = root.kind === 'authorized-directory' && suffix === ''
      for (const name of self ? parsed.names : parsed.names.slice(0, -1)) {
        aborted(signal)
        parent = opened(await executor.execute({ kind: 'open', parent: parent.token, name, directory: true, content: false }))
        if (safeMetadata(parent.metadata).type !== 'directory') throw new FsError('Parent is not a directory', 'FS_NOT_DIRECTORY')
      }
      const parentToken = parent.token
      const name = self ? undefined : parsed.names.at(-1)
      const get = async (content: boolean) => {
        if (closed) throw new FsError('Directory capability is closed', 'FS_IO_ERROR')
        aborted(signal)
        const result = name === undefined ? parent : opened(await executor.execute({ kind: 'open', parent: parentToken, name, directory: false, content }))
        safeMetadata(result.metadata)
        return result
      }
      return {
        async probe() {
          try {
            const result = await get(false)
            try { return result.metadata } finally { if (name !== undefined) await executor.execute({ kind: 'close', token: result.token }) }
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
            throw error
          }
        },
        async openRead(readSignal) {
          aborted(readSignal)
          const result = await get(true)
          let readClosed: Promise<void> | undefined
          return {
            identity: result.metadata.identity,
            async read(buffer, offset, length, position) {
              aborted(readSignal)
              if (readClosed || !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length)
                || length < 0 || offset < 0 || offset + length > buffer.length) throw new FsError('Invalid handle read range', 'FS_IO_ERROR')
              const reply = await executor.execute({ kind: 'read', token: result.token, position: BigInt(position), length })
              if (reply.kind !== 'bytes' || reply.bytes.length > length) throw new FsError('Invalid native read result', 'FS_IO_ERROR')
              buffer.set(reply.bytes, offset)
              return reply.bytes.length
            },
            close() {
              return readClosed ??= (async () => { if (name !== undefined) await executor.execute({ kind: 'close', token: result.token }) })()
            },
          }
        },
        readForEdit: () => Promise.resolve().then(refuseWindowsWrite),
        readTextForDiff: () => Promise.resolve().then(refuseWindowsWrite),
        write: () => Promise.resolve().then(refuseWindowsWrite),
        remove: () => Promise.resolve().then(refuseWindowsWrite),
        close,
      }
    } catch (error) { await close(); throw error }
  }

  async openRead(path: FsTargetKey, signal?: AbortSignal): Promise<ReadHandle> {
    const target = await this.openTarget(path, false, { kind: 'filesystem' }, signal)
    try {
      const handle = await target.openRead(signal)
      let closed: Promise<void> | undefined
      return { identity: handle.identity, read: (...args) => handle.read(...args), close: () => closed ??= (async () => {
        try { await handle.close() } finally { await target.close() }
      })() }
    } catch (error) { await target.close(); throw error }
  }

  async probe(path: string, signal?: AbortSignal): Promise<PathInfo | null> {
    let target: DirectoryCapability
    try { target = await this.openTarget(path, false, { kind: 'filesystem' }, signal) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    try { return await target.probe() } finally { await target.close() }
  }

  probeNoFollow(path: string, signal?: AbortSignal): Promise<PathInfo | null> { return this.probe(path, signal) }

  async list(target: LocalTarget, signal?: AbortSignal): Promise<LocalDirEntry[]> {
    const parsed = pathParts('', target.targetKey)
    const executor = this.executor()
    try {
      aborted(signal)
      let parent = opened(await executor.execute({ kind: 'root', path: parsed.root }))
      safeMetadata(parent.metadata)
      for (const name of parsed.names) {
        aborted(signal)
        parent = opened(await executor.execute({ kind: 'open', parent: parent.token, name, directory: true, content: false }))
        safeMetadata(parent.metadata)
      }
      if (parent.metadata.type !== 'directory') throw new FsError('Not a directory', 'FS_NOT_DIRECTORY')
      const result: LocalDirEntry[] = []
      const names = await enumerateWindows(executor, parent.token, signal)
      for (const name of names.sort((a, b) => a.localeCompare(b))) {
        aborted(signal)
        const childTarget = {
          displayPath: win32.join(target.displayPath, name), targetKey: FsTargetKey(win32.join(target.targetKey, name)),
        }
        try {
          const child = opened(await executor.execute({ kind: 'open', parent: parent.token, name, directory: false, content: false }))
          try {
            const metadata = safeMetadata(child.metadata)
            result.push({ name, target: childTarget, type: metadata.type, version: metadata.version, ...(metadata.type === 'file' ? { size: metadata.size } : {}) })
          } finally { await executor.execute({ kind: 'close', token: child.token }) }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          result.push({ name, target: childTarget, type: 'other' })
        }
      }
      return result
    } finally { await executor.close() }
  }
}
