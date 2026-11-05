/** Linux operations retain directory descriptors instead of resolving mutable ancestors again. */
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { FsError } from '@panedesk/dsh-fs'

/** An operation-owned pathname relative to a retained directory descriptor. */
export interface DirectoryTarget {
  /** Internal I/O path; never exposed as a target key or display name. */
  path: string
  /** Release the directory after every operation using it has settled. */
  close(): Promise<void>
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/**
 * Retain a canonical directory, opening each component without following links.
 * @param path - Canonical absolute directory name.
 * @param create - Create missing components below root, or require existing directories when false.
 * @param root - Existing authorized directory; omission allows the whole filesystem.
 * @returns Owned descriptor path on Linux; other platforms retain their existing path backend.
 */
export async function openDirectory(path: string, create = false, root = '/'): Promise<DirectoryTarget> {
  if (process.platform !== 'linux') return { path, close: async () => {} }
  const suffix = relative(root, path)
  if (!isAbsolute(path) || !isAbsolute(root) || path.split('/').includes('..')
    || suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) {
    throw new FsError('Cannot access outside the authorized directory', 'FS_SANDBOX_DENIED')
  }
  let handle: FileHandle | undefined
  try {
    handle = await open('/', directoryFlags)
    // Acquire the authorized root before creating or resolving any descendant.
    for (const component of root.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${handle.fd}/${component}`, directoryFlags)
      const previous = handle
      handle = next
      await previous.close()
    }
    for (const component of suffix.split('/').filter(Boolean)) {
      const child = `/proc/self/fd/${handle.fd}/${component}`
      if (create) {
        try { await mkdir(child) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      let next: FileHandle
      try {
        next = await open(child, directoryFlags)
      } catch (error) {
        if (error instanceof Error && 'code' in error
          && (error.code === 'ELOOP' || (error.code === 'ENOTDIR' && (await lstat(child)).isSymbolicLink()))) {
          throw new FsError('Cannot access a replaced directory', 'FS_SANDBOX_DENIED', { cause: error })
        }
        throw error
      }
      const previous = handle
      handle = next
      await previous.close()
    }
    const retained = handle
    return { path: `/proc/self/fd/${retained.fd}`, close: () => retained.close() }
  } catch (error) {
    await handle?.close()
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new FsError('Cannot access a replaced directory', 'FS_SANDBOX_DENIED', { cause: error })
    }
    throw error
  }
}

/**
 * Retain the parent for the entire probe/read/stage/publish operation.
 * @param path - Canonical absolute filename.
 * @param createParents - Create missing parents when true; otherwise require them.
 * @param root - Existing authorized root; omission allows the whole filesystem.
 * @returns Owned single-entry descriptor-relative target, or the existing non-Linux backend.
 */
export async function openDirectoryTarget(path: string, createParents = false, root = '/'): Promise<DirectoryTarget> {
  if (process.platform !== 'linux') return { path, close: async () => {} }
  if (path === root) {
    const directory = await openDirectory(root)
    return { path: `${directory.path}/.`, close: () => directory.close() }
  }
  const parent = await openDirectory(dirname(path), createParents, root)
  return { path: `${parent.path}/${basename(path)}`, close: () => parent.close() }
}
