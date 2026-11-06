/** Directory operations expose owned capabilities, never an I/O pathname. */
import type { FsTargetKey } from '@panedesk/dsh-fs'
import type { ReadHandle } from './read-handle.ts'
import type { AuthorizeRead, FsIoInternals, LineEndings, LocalDirEntry, LocalTarget, PathInfo, PathLinkInfo } from './directory-legacy.ts'

// These legacy entry points remain available to existing internal callers.
export { openDirectory, openDirectoryTarget, usesDirectoryHandles } from './directory-linux.ts'

/** Metadata policy is decided before the empty staging file accepts content. */
export type StagePolicy =
  | { kind: 'new'; inheritFromDestination: true }
  | { kind: 'replace'; observed: PathInfo }

/** Publication never silently weakens no-replace or metadata preservation. */
export type PublishRequest =
  | { kind: 'create-if-absent'; displayPath: string }
  | { kind: 'replace'; observed: PathInfo; metadataProfile: string }
  | { kind: 'create-or-replace'; metadataProfile: string }

/** A committed publication remains successful even if private residue cannot be removed. */
export interface PublishResult {
  committed: true
  metadata: PathInfo | null
}

/** Owned file operations use lossless offsets; close waits for in-flight operations. */
export interface OwnedFile {
  inspect(): Promise<PathInfo>
  read(buffer: Buffer, offset: number, length: number, position: bigint): Promise<number>
  write(buffer: Buffer, offset: number, length: number, position: bigint): Promise<number>
  flush(): Promise<void>
  close(): Promise<void>
}

/** The adapter owns security, flush ordering, publication and uncommitted cleanup.
 * Closing a stage discards it unless publication already committed. Cancellation is
 * observed before publication, never reported as a rollback after commitment.
 */
export interface OwnedStage {
  readonly file: OwnedFile
  prepareMetadata(): Promise<void>
  publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResult>
  discard(): Promise<void>
  close(): Promise<void>
}

/** One retained target; all operations settle before close releases its ancestors. */
export interface DirectoryCapability {
  /** Open one child directory relative to this directory; retain the parent until child close. */
  walk(name: string, options: { create: boolean }, signal?: AbortSignal): Promise<DirectoryCapability>
  /** Allocate an adapter-owned stage for one validated child name. */
  stage(name: string, policy: StagePolicy, signal?: AbortSignal): Promise<OwnedStage>
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
  assertWritable(): void | Promise<void>
}
