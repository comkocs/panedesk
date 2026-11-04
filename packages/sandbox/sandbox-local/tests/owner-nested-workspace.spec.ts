/** Nested owner directories retain their names while unrelated workspace branches stay writable. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launcherPath } from '@panedesk/node-addon-system/landlock-run'
import { expect, it, onTestFinished } from 'vitest'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'owner-nested-'))
  onTestFinished(() => { rmSync(workspace, { recursive: true, force: true }) })
  const home = join(workspace, 'home')
  const owner = join(home, 'nested', 'private')
  const other = join(workspace, 'project')
  mkdirSync(owner, { recursive: true })
  mkdirSync(other)
  const document = join(owner, 'credentials')
  writeFileSync(document, 'synthetic owner document')
  const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace, unreadablePaths: [owner] }
  return { workspace, home, owner, other, document, policy }
}

it('masks nested owner material after binding its first workspace child read-only', () => {
  const { home, owner, policy } = fixture()
  const args = bwrapProfileArgs(policy)
  expect(args.join('\n')).toContain(['--ro-bind', home, home].join('\n'))
  expect(args.join('\n')).toContain(['--perms', '000', '--tmpfs', owner, '--remount-ro', owner].join('\n'))
  expect(args.indexOf('--tmpfs', args.indexOf(home))).toBeGreaterThan(args.indexOf(home))
})

it('denies Seatbelt owner reads and ancestor replacement without denying unrelated branches', () => {
  const { home, owner, policy } = fixture()
  const profile = seatbeltProfileArgs(policy)[1]
  expect(profile).toContain(`(deny file-read* (subpath "${owner}"))`)
  expect(profile).toContain(`(deny file-write* (subpath "${home}"))`)
  expect(profile).toContain(`(deny file-write-unlink (literal "${home}"))`)
  expect(profile).toContain(`(deny file-write-unlink (literal "${join(home, 'nested')}"))`)
})

it('Landlock denies owner reads, six replacement methods and root creation while allowing a sibling', () => {
  const { workspace, home, owner, other, document, policy } = fixture()
  const args = landlockProfileArgs(policy)
  const command = `
    reject() { if "$@" 2>/dev/null; then exit 21; fi; }
    reject cat "$1"
    reject sh -c 'printf overwrite > "$1"' sh "$1"
    reject sh -c 'printf append >> "$1"' sh "$1"
    reject truncate -s 0 "$1"
    reject rm "$1"
    reject mv "$2" "$2-moved"
    reject mv "$3" "$3-moved"
    reject mv "$4" "$4-moved"
    reject rm -rf "$3"
    reject sh -c 'rm -rf "$1" && mkdir -p "$1" && printf replaced > "$1/credentials"' sh "$2"
    reject mkdir "$2/new-directory"
    reject ln -s "$5" "$2/replacement"
    reject sh -c 'rm -rf "$1" && ln -s "$2" "$1"' sh "$2" "$5"
    reject sh -c 'printf new > "$1/new-root"' sh "$6"
    printf sibling-ok > "$5/allowed"
    printf confined-ok
  `
  const result = spawnSync(launcherPath(), [...args, '--', '/bin/sh', '-c', command, 'sh',
    document, owner, home, join(home, 'nested'), other, workspace], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('confined-ok')
  expect(readFileSync(document, 'utf8')).toBe('synthetic owner document')
  expect(readFileSync(join(other, 'allowed'), 'utf8')).toBe('sibling-ok')
})

it('prepares missing nested owner storage before Landlock can race to create it', () => {
  const { owner, policy } = fixture()
  rmSync(owner, { recursive: true })
  const args = landlockProfileArgs(policy)
  const result = spawnSync(launcherPath(), [...args, '--', '/bin/sh', '-c',
    'if mkdir "$1/injected" 2>/dev/null; then exit 21; fi; if printf forged > "$1/credentials" 2>/dev/null; then exit 22; fi; printf confined-ok',
    'sh', owner], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('confined-ok')
})

it('still refuses a workspace inside owner material with a bilingual recovery instruction', () => {
  const { owner, policy } = fixture()
  for (const build of [bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs]) {
    expect(() => build({ ...policy, workspaceRoot: owner })).toThrow(
      'Put the credentials file in a dedicated directory outside the workspace. / 把凭据文件放进单独目录，且与工作区互不包含。',
    )
  }
})
