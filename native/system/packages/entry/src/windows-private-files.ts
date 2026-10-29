/** Lazy in-process Windows ACL metadata and write-through file replacement. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

interface WindowsPrivateBinding {
  inspect(path: string, directory?: string): unknown
  secure(path: string): void
  replace(source: string, target: string): number
}

function binding(): WindowsPrivateBinding {
  if (process.platform !== 'win32') throw new Error('Windows private security operation unavailable')
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@panedesk/node-addon-system-win32-${process.arch}/package.json`)
  return require(join(dirname(manifest), 'bin', 'system.node')) as WindowsPrivateBinding
}

/** Inspect current SID, owner, DACL and all ancestors; returns metadata only.
 * @param path - Absolute local path checked by the private-file provider.
 * @param directory - Private root to inspect with the file; omitted for directories.
 * @returns Metadata for fail-closed validation, never file contents.
 */
export function inspectWindowsPrivatePath(path: string, directory?: string): unknown {
  return directory === undefined ? binding().inspect(path) : binding().inspect(path, directory)
}

/** Replace the DACL of a newly and exclusively created empty object before writing content.
 * @param path - New empty file or directory; never existing data.
 */
export function secureWindowsPrivatePath(path: string): void {
  binding().secure(path)
}

/** Replace within one volume using REPLACE_EXISTING and WRITE_THROUGH, without COPY_ALLOWED.
 * @param source - Secured, flushed temporary file in the target directory.
 * @param target - Checked destination.
 * @returns Zero on success, otherwise the captured Win32 error number.
 */
export function replaceWindowsPrivatePath(source: string, target: string): number {
  return binding().replace(source, target)
}
