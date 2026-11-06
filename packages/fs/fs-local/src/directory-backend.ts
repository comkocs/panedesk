/** Instance-owned backend selection never retries a failed handle operation through paths. */
import { legacyBackend } from './directory-legacy.ts'
import { WindowsDirectoryBackend } from './directory-win32.ts'
import type { DirectoryBackend } from './directory-handle.ts'

/** Select only from protected provider configuration; Linux ignores the Windows-only choice.
 * @param choice - Validated provider setting; experimental selects the handle backend on Windows.
 * @returns The instance's immutable backend.
 */
export function createDirectoryBackend(choice: 'disabled' | 'experimental'): DirectoryBackend {
  return process.platform === 'win32' && choice === 'experimental'
    ? new WindowsDirectoryBackend() : legacyBackend()
}
