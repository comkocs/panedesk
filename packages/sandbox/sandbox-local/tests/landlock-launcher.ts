/** Native regressions compile the checked-out launcher instead of relying on ignored release binaries. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'

/**
 * Build this checkout's C launcher for a native regression, with test-owned cleanup.
 * @returns The host-compiled executable; this is not a musl release artifact.
 */
export function buildLandlockLauncher(): string {
  const directory = mkdtempSync(join(tmpdir(), 'landlock-launcher-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const launcher = join(directory, 'landlock-run')
  const source = fileURLToPath(new URL('../../../../native/system/packages/entry/src/main.c', import.meta.url))
  const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', launcher], {
    encoding: 'utf8', timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot compile the Landlock regression launcher: ${result.stderr}`)
  return launcher
}
