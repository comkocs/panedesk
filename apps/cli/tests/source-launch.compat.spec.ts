import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { testProfileResolution } from './profiles/headless/tests/profile-resolution.ts'

/**
 * Keyless source-launch and profile-resolution checks through the production
 * tsx ESM-only entry. The Node compatibility matrix runs this file without a
 * build; source tool execution with native/generated dependencies belongs to
 * the build-backed source-tool suite.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('panedesk SOURCE launcher (node --import tsx/esm)', () => {
  testProfileResolution('src')

  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.panedesk).toBe('node --import tsx/esm apps/cli/src/bin.ts')
    expect(rootPackage.scripts?.pdesk).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('boots the source entry and prints the launcher help when given nothing to run', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`panedesk source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    // A bare invocation has no task and no profile to hand help to: the launcher prints its own help and exits 0.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: panedesk')
    expect(result.stdout).toContain('slim (default)')
    expect(result.stderr).toBe('')
  }, 30_000)
})
