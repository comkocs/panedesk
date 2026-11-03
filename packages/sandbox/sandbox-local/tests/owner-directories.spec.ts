/** Directory isolation survives atomic replacement without hiding product attachments. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

function fixture(mode: 'read-only' | 'workspace-write') {
  const root = mkdtempSync(join(tmpdir(), 'owner-directories-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const owner = join(root, 'private')
  const workspace = join(root, 'workspace')
  const attachments = join(root, 'attachments')
  mkdirSync(workspace)
  mkdirSync(attachments)
  return { root, owner, workspace, attachments, policy: { mode, workspaceRoot: workspace, unreadablePaths: [owner] } }
}

it.each(['read-only', 'workspace-write'] as const)('isolates an absent owner directory without refusing startup in %s', (mode) => {
  const { owner, attachments, policy } = fixture(mode)
  const args = bwrapProfileArgs(policy)
  expect(args.join('\n')).toContain(['--tmpfs', owner].join('\n'))
  expect(args).not.toContain(attachments)
  expect(args).toContain('--new-session')
  expect(seatbeltProfileArgs(policy)[1]).toContain(`(deny file-read* (subpath "${owner}"))`)
})

it.each(['read-only', 'workspace-write'] as const)('allows Landlock siblings but never the owner directory in %s', (mode) => {
  const { owner, attachments, policy } = fixture(mode)
  mkdirSync(owner)
  const args = landlockProfileArgs(policy)
  expect(args).not.toContain('/')
  expect(args).not.toContain(owner)
  expect(args).toContain(attachments)
})

it('keeps the bwrap directory mask after atomic credential replacement', () => {
  const { owner, policy } = fixture('workspace-write')
  mkdirSync(owner)
  const file = join(owner, '.credentials.yaml')
  writeFileSync(file, 'synthetic old document')
  const before = bwrapProfileArgs(policy)
  writeFileSync(join(owner, 'replacement'), 'synthetic new document')
  renameSync(join(owner, 'replacement'), file)
  expect(bwrapProfileArgs(policy)).toEqual(before)
  expect(before.join('\n')).toContain(['--tmpfs', owner].join('\n'))
})

it('refuses overlapping owner and workspace directories with an actionable bilingual reason', () => {
  const { owner, policy } = fixture('workspace-write')
  mkdirSync(owner)
  const overlapping = { ...policy, workspaceRoot: owner }
  expect(() => bwrapProfileArgs(overlapping)).toThrow('Put the credentials file in a dedicated directory')
  expect(() => seatbeltProfileArgs(overlapping)).toThrow('把凭据文件放进单独目录')
})
