/** Native profiles must make owner identity files unavailable, not merely read-only. */
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

function fixture(mode: 'read-only' | 'workspace-write') {
  const root = mkdtempSync(join(homedir(), '.owner-material-profile-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const owner = join(root, 'private')
  mkdirSync(owner, { mode: 0o700 })
  const document = join(owner, '.credentials.yaml')
  writeFileSync(document, 'synthetic credential document', { mode: 0o600 })
  return { document, owner, workspace, policy: { mode, workspaceRoot: workspace, unreadablePaths: [owner] } }
}

it.each(['read-only', 'workspace-write'] as const)('masks owner directories in bwrap, Seatbelt, and Landlock in %s', (mode) => {
  const { owner, workspace, policy } = fixture(mode)
  expect(bwrapProfileArgs(policy).join('\n')).toContain(['--tmpfs', owner].join('\n'))
  expect(seatbeltProfileArgs(policy)[1]).toContain(`(deny file-read* (subpath "${owner}"))`)
  const grants = landlockProfileArgs(policy)
  expect(grants).not.toContain(owner)
  expect(grants).not.toContain('/')
  expect(grants).toContain(workspace)
})

it('refuses a path-only native profile when owner material has a hard-link alias', () => {
  const { document, workspace, policy } = fixture('workspace-write')
  linkSync(document, join(workspace, 'alias'))
  expect(() => bwrapProfileArgs(policy)).toThrow('Owner identity material cannot be isolated')
  expect(() => seatbeltProfileArgs(policy)).toThrow('Owner identity material cannot be isolated')
})

for (const mode of ['read-only', 'workspace-write'] as const) it(`native bwrap shell cannot read the credential document in ${mode}`, ({ skip }) => {
  if (process.platform !== 'linux') skip('native bubblewrap requires Linux')
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', '/bin/true'], { encoding: 'utf8', timeout: 5_000 })
  if (probe.status !== 0) {
    const reason = `bubblewrap unavailable: ${probe.error?.message ?? probe.stderr.trim()}; status=${probe.status}`
    console.info(reason)
    skip(reason)
  }
  const { document, policy } = fixture(mode)
  const control = spawnSync('bwrap', [...bwrapProfileArgs({ ...policy, unreadablePaths: [] }), '--', '/bin/sh', '-c', 'test -s "$1"', 'sh', document], { encoding: 'utf8', timeout: 10_000 })
  expect(control.status, control.stderr).toBe(0)
  const result = spawnSync('bwrap', [...bwrapProfileArgs(policy), '--', '/bin/sh', '-c', 'test ! -r "$1"', 'sh', document], { encoding: 'utf8', timeout: 10_000 })
  expect(result.status, result.stderr).toBe(0)
})
