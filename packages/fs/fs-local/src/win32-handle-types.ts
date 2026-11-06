/** Native operations own their HANDLEs; only executor-local tokens cross the worker channel. */
import type { FsVersion } from '@panedesk/dsh-fs'
import type { ReadIdentity } from './read-handle.ts'
import type { DirectoryCapability, OwnedStage, PublishRequest, PublishResult, StagePolicy } from './directory-handle.ts'

/** Metadata read from one open object, never from a reopened final name. */
export interface HandleMetadata {
  identity: ReadIdentity
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
  attributes: number
  reparseTag: number
}

/** Read-only requests accepted by the native owner. */
export type HandleReadRequest =
  | { kind: 'root'; path: string }
  | { kind: 'open'; parent: number; name: string; directory: boolean; content: boolean }
  | { kind: 'inspect'; token: number }
  | { kind: 'read'; token: number; position: bigint; length: number }
  | { kind: 'enumerate'; token: number; size: number; restart: boolean }
  | { kind: 'close'; token: number }
  | { kind: 'shutdown' }

/** Successful worker replies are discriminated independently from native error domains. */
export type HandleReply =
  | HandleWriteReply
  | { kind: 'opened'; token: number; metadata: HandleMetadata }
  | { kind: 'metadata'; metadata: HandleMetadata }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'directory'; status: number; bytes: Uint8Array }
  | { kind: 'closed' }

/** Mutation messages carry only retained-object tokens and single child names. */
export type HandleWriteRequest =
  | { kind: 'create-directory'; parent: number; name: string }
  | { kind: 'stage'; parent: number; name: string; policy: StagePolicy }
  | { kind: 'stage-inspect'; token: number }
  | { kind: 'stage-read'; token: number; position: bigint; length: number }
  | { kind: 'write'; token: number; bytes: Uint8Array; position: bigint }
  | { kind: 'flush'; token: number }
  | { kind: 'prepare-metadata'; token: number }
  | { kind: 'publish'; token: number; request: PublishRequest }
  | { kind: 'remove'; parent: number; name: string; type: 'file' | 'empty-directory' }
  | { kind: 'discard'; token: number }
  | { kind: 'stage-close'; token: number }

/** Complete private worker requests; offsets never pass through floating-point numbers. */
export type HandleRequest = HandleReadRequest | HandleWriteRequest

/** Successful mutations distinguish byte progress from the irreversible commit point. */
export type HandleWriteReply =
  | { kind: 'staged'; token: number }
  | { kind: 'written'; bytes: number }
  | { kind: 'published'; result: PublishResult }
  | { kind: 'completed' }

/** A retained target supplies all read and mutation capabilities without an I/O pathname. */
export interface WindowsWriteTarget {
  parent: number
  entry: { kind: 'self' } | { kind: 'child'; name: string }
  execute(request: HandleRequest): Promise<HandleReply>
  openRead: DirectoryCapability['openRead']
  probe: DirectoryCapability['probe']
}

/** Main-thread adapter: transaction policy stays in the optional write module.
 * It must not consult FsIoInternals, reopen identity names or fall back to Node paths.
 */
export interface WindowsWriteExtension {
  createDirectory(parent: number, name: string): Promise<Extract<HandleReply, { kind: 'opened' }>>
  stage(parent: number, name: string, policy: StagePolicy, signal?: AbortSignal): Promise<OwnedStage>
  readForEdit: DirectoryCapability['readForEdit']
  readTextForDiff: DirectoryCapability['readTextForDiff']
  write: DirectoryCapability['write']
  remove(): Promise<void>
}

/** Worker-only access to the read owner's handle table; native pointers never cross IPC.
 * adopt validates the object and owns it even if inspection fails. release removes
 * ownership before CloseHandle, so a failed close must never be retried.
 */
export interface WindowsNativeContext {
  get(token: number): object
  adopt(handle: object): Extract<HandleReply, { kind: 'opened' }>
  inspect(handle: object): HandleMetadata
  release(token: number): void
}

/** Native write owner must settle buffers and discard uncommitted stages before shutdown. */
export interface WindowsWriteHandler {
  execute(request: HandleWriteRequest): HandleReply | Promise<HandleReply>
  close(): void | Promise<void>
}

/** Fixed internal module exports, used in both source and bundled runtime planes. */
export interface WindowsWriteModule {
  createWindowsWriteExtension(target: WindowsWriteTarget): WindowsWriteExtension
  createWindowsWriteHandler(context: WindowsNativeContext): WindowsWriteHandler
}

/** A request completes before its buffers or handles may be released. */
export interface HandleExecutor {
  execute(request: HandleRequest): Promise<HandleReply>
  close(): Promise<void>
}
