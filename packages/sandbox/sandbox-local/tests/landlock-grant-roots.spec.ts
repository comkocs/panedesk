/** Unavailable enumerated roots never reach older Landlock launchers. */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { landlockProfileArgs } from '../src/profiles.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

it.each(['ENOENT', 'EACCES', 'EPERM'] as const)('omits a sibling whose final stat fails with %s', (code) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'landlock-grants-'))
  const owner = join(root, 'private')
  const sibling = join(root, 'sibling')
  fs.mkdirSync(owner)
  fs.mkdirSync(sibling)
  const stat = fs.statSync
  const spy = vi.spyOn(fs, 'statSync').mockImplementation((path, options) => {
    if (path === sibling) throw Object.assign(new Error('unavailable sibling'), { code })
    return stat(path, options)
  })
  onTestFinished(() => {
    spy.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const args = landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: root, unreadablePaths: [owner] })
  expect(args).not.toContain(sibling)
  expect(args).not.toContain(root)
  expect(args).not.toContain(owner)
})
