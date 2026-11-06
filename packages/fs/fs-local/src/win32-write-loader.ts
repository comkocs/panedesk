/** Only the package-owned write module can add mutation capabilities. */
import { FsError } from '@panedesk/dsh-fs'
import type { WindowsWriteModule } from './win32-handle-types.ts'

/** Load the fixed sibling; only its absence means unsupported writes.
 * @returns Validated factory exports, or null when that exact module is absent.
 */
export async function loadWindowsWriteModule(): Promise<WindowsWriteModule | null> {
  const url = new URL(import.meta.url.endsWith('.ts') ? './win32-write-backend.ts' : './win32-write-backend.js', import.meta.url)
  let imported: unknown
  try {
    imported = await import(url.href)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in error && error.url === url.href) return null
    throw new FsError('Windows handle write capability is not ready; module failed to load and path fallback is forbidden / Windows 句柄写能力尚未就绪', 'FS_IO_ERROR', { cause: error })
  }
  if (typeof imported !== 'object' || imported === null
    || !('createWindowsWriteExtension' in imported) || typeof imported.createWindowsWriteExtension !== 'function'
    || !('createWindowsWriteHandler' in imported) || typeof imported.createWindowsWriteHandler !== 'function') {
    throw new FsError('Windows write module does not provide the required factories', 'FS_IO_ERROR')
  }
  return imported as WindowsWriteModule
}
