/** Keep registry tests independent of host Claude agent definitions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, onTestFinished, vi } from 'vitest'

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-agent-sources-'))
  onTestFinished(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.spyOn(process, 'cwd').mockReturnValue(root)
})
