/** Recorded native operations are substitutes, not evidence of Windows kernel behavior. */
import { FsError, FsTargetKey, FsVersion } from '@panedesk/dsh-fs'
import { WindowsDirectoryBackend, enumerateWindows } from '../../src/directory-win32.ts'
import { readWholeText } from '../../src/fsio.ts'
import { LocalFileSystem } from '../../src/index.ts'
import type { HandleExecutor, HandleMetadata, HandleReply, HandleRequest } from '../../src/win32-handle-types.ts'

export function metadata(path: string, directory = false, reparse = false): HandleMetadata {
  return {
    identity: { path, dev: 1n, ino: 2n, size: 4, regular: !directory },
    version: FsVersion('1:2:4:5:6'), mode: 0o666, type: directory ? 'directory' : 'file',
    size: 4, attributes: (directory ? 0x10 : 0) | (reparse ? 0x400 : 0), reparseTag: 0,
  }
}

export function directoryRecord(name: string): Buffer {
  const text = Buffer.from(name, 'utf16le')
  const bytes = Buffer.alloc(64 + text.length)
  bytes.writeUInt32LE(text.length, 60)
  text.copy(bytes, 64)
  return bytes
}

export class RecordedExecutor implements HandleExecutor {
  readonly requests: HandleRequest[] = []
  readonly live = new Set<number>()
  closed = 0
  next = 0
  constructor(private readonly respond?: (request: HandleRequest) => HandleReply | undefined) {}
  async execute(request: HandleRequest): Promise<HandleReply> {
    this.requests.push(request)
    const response = this.respond?.(request)
    if (response) return response
    if (request.kind === 'root' || request.kind === 'open') {
      const token = ++this.next
      this.live.add(token)
      return { kind: 'opened', token, metadata: metadata(request.kind === 'root' ? request.path : `C:\\safe\\${request.name}`, request.kind === 'root' || request.directory) }
    }
    if (request.kind === 'close') { this.live.delete(request.token); return { kind: 'closed' } }
    if (request.kind === 'read') return { kind: 'bytes', bytes: Buffer.from('data').subarray(Number(request.position), Number(request.position) + Math.min(2, request.length)) }
    if (request.kind === 'enumerate') return { kind: 'directory', status: 0x80000006, bytes: Buffer.alloc(0) }
    if (request.kind === 'inspect') return { kind: 'metadata', metadata: metadata('C:\\safe') }
    return { kind: 'closed' }
  }
  async close() { this.closed++; this.live.clear() }
}

export function directoryFixture() {
  const calls: string[] = []
  return {
    calls,
    async walkReparse() {
      const executor = new RecordedExecutor((request) => {
        if (request.kind === 'open' && request.name === 'link') return { kind: 'opened', token: 100, metadata: metadata('C:\\link', true, true) }
        if (request.kind === 'open' && request.name === 'child') calls.push('open-child')
      })
      await new WindowsDirectoryBackend(() => executor).resolve('C:\\', 'link\\child')
    },
    async createBelowMissingRoot() {
      const executor = new RecordedExecutor(() => { throw Object.assign(new Error('Missing root'), { code: 'ENOENT' }) })
      await new WindowsDirectoryBackend(() => executor).openTarget('C:\\absent\\child', true, { kind: 'authorized-directory', displayPath: 'C:\\absent' })
    },
    async readDenied() {
      const executor = new RecordedExecutor((request) => { if (request.kind === 'read') calls.push('read') })
      const backend = new WindowsDirectoryBackend(() => executor)
      await readWholeText({ targetKey: FsTargetKey('C:\\safe\\file'), displayPath: 'C:\\safe\\file', backend }, undefined,
        () => { throw new FsError('Denied identity', 'FS_SANDBOX_DENIED') })
    },
    async enumerateEmptyBuffer() {
      let round = 0
      const executor = new RecordedExecutor((request) => {
        if (request.kind !== 'enumerate') return
        round++
        return round === 1 ? { kind: 'directory', status: 0, bytes: Buffer.alloc(0) }
          : round === 2 ? { kind: 'directory', status: 0, bytes: directoryRecord('file.txt') }
            : { kind: 'directory', status: 0x80000006, bytes: Buffer.alloc(0) }
      })
      return enumerateWindows(executor, 1)
    },
    async failedBackend() {
      const executor = new RecordedExecutor(() => { throw new FsError('Missing native capability', 'FS_IO_ERROR') })
      await new WindowsDirectoryBackend(() => executor).probe('C:\\safe\\file')
    },
    defaultChoice() { return LocalFileSystem.Config({}).windowsHandleBackend },
  }
}
