/** Built headless startup denies a blocked owner-record read before composing any model provider. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it.runIf(process.platform !== 'win32')('exits headless nonzero after a real synchronous record read stalls', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-headless-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const home = join(root, 'owner')
  const workspace = join(root, 'workspace')
  const storage = join(home, 'windows-workspace-write')
  const records = join(storage, 'protected-inputs')
  mkdirSync(records, { recursive: true, mode: 0o700 })
  mkdirSync(workspace)
  writeFileSync(join(storage, 'input-review.json'), '{"stallTimeoutMs":100}', { mode: 0o600 })
  execFileSync('mkfifo', [join(records, 'blocked.json')], { timeout: 5000 })
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/bin.js', import.meta.url)), '--profile', 'headless', 'unused'], {
    cwd: workspace, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH, HOME: root, PANEDESK_HOME: home, PANEDESK_AGENTS_HOME: join(root, 'agents'),
      TMPDIR: tmpdir(), LANG: 'C.UTF-8', CI: 'true' },
  })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(1)
  expect(child.stderr).toMatch(/review stalled.*复核卡住/s)
  expect(child.stderr.indexOf('Panedesk starting')).toBeGreaterThanOrEqual(0)
  expect(child.stderr.indexOf('Panedesk starting')).toBeLessThan(child.stderr.indexOf('Reviewing'))
})
