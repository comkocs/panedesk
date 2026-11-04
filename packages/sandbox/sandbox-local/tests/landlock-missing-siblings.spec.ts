/** Missing or inaccessible optional siblings must not prevent confined execution. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantArgs } from '@panedesk/node-addon-system/landlock-run'
import { buildLandlockLauncher } from './landlock-launcher.ts'
import { expect, it, onTestFinished } from 'vitest'

it.each(['dangling', 'removed', 'inaccessible'] as const)('runs without granting the %s sibling', (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'landlock-siblings-'))
  const blocked = join(root, 'blocked')
  mkdirSync(blocked)
  onTestFinished(() => {
    chmodSync(blocked, 0o700)
    rmSync(root, { recursive: true, force: true })
  })
  const target = join(blocked, 'material')
  writeFileSync(target, 'synthetic private material')
  const sibling = join(root, 'sibling')
  if (kind === 'dangling') symlinkSync(join(root, 'absent'), sibling)
  if (kind === 'removed') writeFileSync(sibling, 'enumerated before deletion')
  const path = kind === 'inaccessible' ? target : sibling
  const args = grantArgs({ readOnly: ['/usr', '/bin', '/lib', '/lib64'].filter(existsSync).concat(path) })
  if (kind === 'removed') rmSync(sibling)
  if (kind === 'inaccessible') chmodSync(blocked, 0)
  const result = spawnSync(buildLandlockLauncher(), [...args, '--', '/bin/sh', '-c',
    'if cat "$1"; then exit 11; fi; if cat "$2"; then exit 12; fi; printf confined-ok', 'sh', path, target],
  { encoding: 'utf8', timeout: 5_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('confined-ok')
})
