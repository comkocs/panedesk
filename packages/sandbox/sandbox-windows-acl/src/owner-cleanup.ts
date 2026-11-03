/** Offline owner-only removal of the dedicated directory's mandatory read label. */
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setOwnerReadProtection } from './acl.ts'
import { sidText } from './ace-diagnostic.ts'
import { allocUint32, decodePtrAt, decodeUint32, freeBytes, throwLastError, win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { makeWellKnownSid, openCurrentProcessToken } from './token.ts'
import * as abi from './win32-abi.ts'

/** Read one variable-sized token record, refusing failed or truncated native responses. */
function tokenRecord(api: Win32Bindings, token: NativePtr, information: number): Buffer {
  const needed = allocUint32()
  api.getTokenInformation(token, information, null, 0, needed)
  const length = decodeUint32(needed)
  if (length < 4) throwLastError(api, 'GetTokenInformation', 'owner cleanup token size')
  const record = Buffer.alloc(length)
  if (api.getTokenInformation(token, information, record, length, needed) === 0) {
    throwLastError(api, 'GetTokenInformation', 'owner cleanup token')
  }
  return record
}

/**
 * Remove owner labels before uninstalling or withdrawing private-directory protection.
 * Stop every product host and sandbox first; ordinary disposal must retain protection.
 * Restricted or below-Medium callers are refused before touching directory labels.
 * @param path Absolute dedicated private directory, never desktop userData.
 * @returns Resolves after every existing descendant and the root pass cleanup readback.
 */
export async function cleanupOwnerReadProtection(path: string): Promise<void> {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error('Owner cleanup requires an absolute, non-link private directory. / 所有者清理需要非链接私密目录的绝对路径。')
  }
  const api = await win32()
  const token = openCurrentProcessToken(api)
  try {
    // TOKEN_INFORMATION_CLASS.TokenRestrictedSids is 11 in winnt.h.
    const restricted = tokenRecord(api, token, 11)
    const integrity = tokenRecord(api, token, abi.TokenIntegrityLevel)
    const sid = integrity.length >= abi.TOKEN_MANDATORY_LABEL_SIZE ? decodePtrAt(integrity, 0) : null
    const level = sid === null ? '' : sidText(sid)
    if (restricted.readUInt32LE(0) !== 0 || !/^S-1-16-(8192|8448|12288|16384)$/.test(level)) {
      throw new Error('Owner cleanup requires an unrestricted Medium-or-higher process. / 所有者清理需要不受限的中等或更高完整性进程。')
    }
    const medium = makeWellKnownSid(api, abi.WinMediumLabelSid)
    try {
      setOwnerReadProtection(api, path, medium, false)
    } finally {
      freeBytes(medium)
    }
  } finally {
    if (api.closeHandle(token) === 0) throwLastError(api, 'CloseHandle', 'owner cleanup token')
  }
}
