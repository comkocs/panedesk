/** Directory operations expose owned capabilities, never an I/O pathname. */
import type { FsTargetKey } from '@panedesk/dsh-fs'
import type { ReadHandle } from './read-handle.ts'
import type { AuthorizeRead, FsIoInternals, LineEndings, LocalDirEntry, LocalTarget, PathInfo, PathLinkInfo } from './directory-legacy.ts'

// These legacy entry points remain available to existing internal callers.
export { openDirectory, openDirectoryTarget, usesDirectoryHandles } from './directory-linux.ts'

/** One retained target; all operations settle before close releases its ancestors. */
export interface DirectoryCapability {
  probe(): Promise<PathInfo | null>
  openRead(signal?: AbortSignal): Promise<ReadHandle>
  readForEdit(displayPath: string, signal?: AbortSignal, authorize?: AuthorizeRead): Promise<{ content: string; lineEndings: LineEndings }>
  readTextForDiff(limit: number, signal?: AbortSignal, authorize?: AuthorizeRead): Promise<string | null>
  write(content: string, mode: number | undefined, signal: AbortSignal | undefined,
    internals: FsIoInternals, createIfAbsent?: { displayPath: string }): Promise<void>
  remove(): Promise<void>
  close(): Promise<void>
}

/** Root selection distinguishes unrestricted volume access from an existing authorized directory. */
export type RootRequest = { kind: 'filesystem' } | { kind: 'authorized-directory'; displayPath: string }

/** Provider-owned selection, fixed for the lifetime of the instance. */
export interface DirectoryBackend {
  readonly choice: 'legacy' | 'windows-handles'
  resolve(cwd: string, path: string, signal?: AbortSignal): Promise<LocalTarget>
  probe(path: string, signal?: AbortSignal): Promise<PathInfo | null>
  probeNoFollow(path: string, signal?: AbortSignal): Promise<PathLinkInfo | null>
  list(target: LocalTarget, signal?: AbortSignal): Promise<LocalDirEntry[]>
  openRead(path: FsTargetKey, signal?: AbortSignal): Promise<ReadHandle>
  openTarget(path: string, createParents: boolean, root: RootRequest, signal?: AbortSignal): Promise<DirectoryCapability>
  assertWritable(): void
}
