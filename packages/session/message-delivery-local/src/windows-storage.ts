/** Windows mailbox publication and handle-owned byte-range locks through public bindings. */
import { toNamespacedPath } from 'node:path'
import { extendWin32ProcessBindings, isNullPtr, type NativePtr } from '@panedesk/dsh-win32-process'
import { MailboxUnavailableError } from './files.ts'

function bindings() {
  return extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createFile: bind(kernel32, 'CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']) as (path: string, access: number, share: number, security: null, disposition: number, flags: number, template: null) => NativePtr,
    lockFile: bind(kernel32, 'LockFileEx', 'int', ['void*', 'uint32', 'uint32', 'uint32', 'uint32', 'void*']) as (handle: NativePtr, flags: number, reserved: number, low: number, high: number, overlapped: Buffer) => number,
    moveFile: bind(kernel32, 'MoveFileExW', 'int', ['str16', 'str16', 'uint32']) as (source: string, destination: string, flags: number) => number,
  }))
}

/** Acquire a nonrecursive byte-range lock; process exit closes the owning handle.
 * @param path - canonical private mailbox lock path.
 * @returns a release closure, or undefined while another handle holds the range.
 */
export function tryWindowsLock(path: string): (() => void) | undefined {
  const api = bindings()
  const handle = api.createFile(toNamespacedPath(path), 0x80000000 | 0x40000000, 0x1 | 0x2, null, 4, 0x00200000, null)
  if (isNullPtr(handle) || handle === -1n || handle === 0xffffffffffffffffn) throw new MailboxUnavailableError('Windows mailbox lock could not be opened')
  const overlapped = Buffer.alloc(32)
  if (api.lockFile(handle, 0x1 | 0x2, 0, 1, 0, overlapped)) {
    return () => { if (!api.closeHandle(handle)) throw new MailboxUnavailableError('Windows mailbox lock release failed') }
  }
  const error = api.getLastError()
  api.closeHandle(handle)
  if (error === 33) return undefined
  throw new MailboxUnavailableError(`Windows mailbox lock failed (${error})`)
}

/** Replace a synced staging file using same-volume write-through rename.
 * @param source - exclusive temporary file.
 * @param destination - final private file.
 */
export function publishWindowsFile(source: string, destination: string): void {
  const api = bindings()
  if (!api.moveFile(toNamespacedPath(source), toNamespacedPath(destination), 0x1 | 0x8)) {
    throw new MailboxUnavailableError('Windows mailbox publication failed')
  }
}
