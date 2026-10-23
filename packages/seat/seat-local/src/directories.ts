/** Additional-root access preserves provider confinement and explicit write admission. */
import path from 'node:path'
import type { FileSystem } from '@panedesk/dsh-fs'
import type { SandboxExecutionPolicy } from '@panedesk/dsh-sandbox'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatDefinition, SeatDirectoryEditRequest, SeatDirectoryReadRequest, SeatDirectoryReadResult,
  SeatDirectoryRoot, SeatDirectoryWriteRequest, SeatDirectoryWriteResult, SeatName, SeatRejected } from '@panedesk/dsh-seat'
import { canonicalPath, checkMemoryWrite } from './identity.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Runtime authorization is derived from the caller's session, never request-supplied roots. */
export interface DirectoryAccessContext {
  seat: SeatName | null
  definitions: readonly SeatDefinition[]
  policy: SandboxExecutionPolicy
  admitWrite(target: string): Promise<SeatRejected | null>
}

/** File operations use the installed filesystem rather than bypassing it with host writes. */
export class SeatDirectoryAccess {
  constructor(private readonly fs: FileSystem,
    private readonly context: (sessionId: SessionId) => Promise<DirectoryAccessContext>) {}

  /** Enumerate only the caller's registered roots.
   * @param sessionId - authenticated window.
   * @returns startup, additional and memory roots.
   */
  async roots(sessionId: SessionId): Promise<SeatDirectoryRoot[]> {
    const context = await this.context(sessionId)
    const definition = context.definitions.find(item => item.seat === context.seat)
    if (definition === undefined) return []
    const roots: SeatDirectoryRoot[] = []
    for (const directory of definition.directories) roots.push({ rootId: String(digest(directory.path)) as SeatDirectoryRoot['rootId'],
      path: await canonicalPath(directory.path), kind: directory.startup ? 'startup' : 'additional', writable: context.policy.mode !== 'read-only' })
    for (const directory of definition.memoryDirectories) roots.push({ rootId: String(digest(directory)) as SeatDirectoryRoot['rootId'],
      path: await canonicalPath(directory), kind: 'memory', writable: context.policy.mode !== 'read-only' })
    return roots
  }

  private async target(request: SeatDirectoryReadRequest | SeatDirectoryWriteRequest | SeatDirectoryEditRequest) {
    const root = (await this.roots(request.sessionId)).find(item => item.rootId === request.rootId)
    if (root === undefined || path.isAbsolute(request.relativePath)) return rejected('unauthorized', 'Select a registered root and relative path.', 'List the available seat directories first.')
    const base = await this.fs.resolve(root.path)
    const target = await this.fs.resolve(request.relativePath, { cwd: root.path })
    if (!this.fs.contains(base, target)) return rejected('unauthorized', 'The target escapes the selected root.', 'Use a path inside the registered root.')
    return { root, target }
  }

  /** Read a bounded UTF-8 window; reads do not require memory ownership.
   * @param request - registered root and byte bound.
   * @returns content with explicit completeness.
   */
  async read(request: SeatDirectoryReadRequest): Promise<SeatDirectoryReadResult> {
    const resolved = await this.target(request)
    if ('status' in resolved) return resolved
    const bytes = await this.fs.readByteRange(resolved.target, { offset: 0, length: request.maxBytes + 1 })
    const complete = bytes.length <= request.maxBytes
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return { status: 'read', content: decoder.decode(bytes.subarray(0, request.maxBytes), { stream: !complete }), complete }
  }

  /** Write with ownership and runtime permission checks immediately before the provider call.
   * @param request - selected root and full contents.
   * @returns committed path or an actionable refusal.
   */
  async write(request: SeatDirectoryWriteRequest): Promise<SeatDirectoryWriteResult> {
    return this.mutate(request, async (target, policy) => {
      await this.fs.writeText(target, request.content, undefined, undefined, policy)
    })
  }

  /** Apply one exact replacement under the same admission as writing.
   * @param request - literal old and new text.
   * @returns committed path or refusal.
   */
  async edit(request: SeatDirectoryEditRequest): Promise<SeatDirectoryWriteResult> {
    return this.mutate(request, async (target, policy) => { await this.fs.editText(target,
      { oldString: request.oldText, newString: request.newText, replaceAll: false }, undefined, undefined, policy) })
  }

  private async mutate(request: SeatDirectoryWriteRequest | SeatDirectoryEditRequest,
    execute: (target: Awaited<ReturnType<FileSystem['resolve']>>, policy: SandboxExecutionPolicy) => Promise<void>): Promise<SeatDirectoryWriteResult> {
    const resolved = await this.target(request)
    if ('status' in resolved) return resolved
    const context = await this.context(request.sessionId)
    const targetPath = this.fs.processPath(resolved.target)
    const memory = await checkMemoryWrite(targetPath, context.seat, context.definitions)
    if (memory !== null) return memory
    if (context.policy.mode === 'read-only') return rejected('unauthorized', 'The session is read-only.', 'Request write permission before modifying files.')
    const permission = await context.admitWrite(targetPath)
    if (permission !== null) return permission
    await execute(resolved.target, { ...context.policy, workspaceRoot: resolved.root.path, sessionId: request.sessionId })
    return { status: 'written', path: targetPath }
  }
}
