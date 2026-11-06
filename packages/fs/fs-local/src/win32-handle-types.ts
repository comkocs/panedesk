/** Native operations own their HANDLEs; only executor-local tokens cross the worker channel. */
import type { FsVersion } from '@panedesk/dsh-fs'
import type { ReadIdentity } from './read-handle.ts'

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

/** Requests accepted by the private worker, with offsets kept lossless. */
export type HandleRequest =
  | { kind: 'root'; path: string }
  | { kind: 'open'; parent: number; name: string; directory: boolean; content: boolean }
  | { kind: 'inspect'; token: number }
  | { kind: 'read'; token: number; position: bigint; length: number }
  | { kind: 'enumerate'; token: number; size: number; restart: boolean }
  | { kind: 'close'; token: number }
  | { kind: 'shutdown' }

/** Successful worker replies are discriminated independently from native error domains. */
export type HandleReply =
  | { kind: 'opened'; token: number; metadata: HandleMetadata }
  | { kind: 'metadata'; metadata: HandleMetadata }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'directory'; status: number; bytes: Uint8Array }
  | { kind: 'closed' }

/** Fixed write-extension obligations; no path-based implementation is accepted. */
export interface WindowsWriteExtension {
  createDirectory(parent: number, name: string): Promise<number>
  stage(parent: number, name: string, observed: HandleMetadata | null): Promise<number>
  write(token: number, bytes: Uint8Array, position: bigint): Promise<number>
  flush(token: number): Promise<void>
  prepareMetadata(token: number): Promise<void>
  publish(token: number, parent: number, name: string, replace: boolean): Promise<HandleMetadata | null>
  remove(token: number): Promise<void>
  discard(token: number): Promise<void>
}

/** A request completes before its buffers or handles may be released. */
export interface HandleExecutor {
  execute(request: HandleRequest): Promise<HandleReply>
  close(): Promise<void>
}
