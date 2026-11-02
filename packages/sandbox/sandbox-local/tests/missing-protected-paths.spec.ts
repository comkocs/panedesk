/** Missing host inputs must not turn unrelated writable siblings read-only. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { bwrapProfileArgs } from '../src/profiles.ts'

it('keeps a writable workspace beside a missing protected input writable', () => {
  const root = mkdtempSync(join(homedir(), '.sandbox-siblings-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  const protectedPath = join(root, 'host', 'config.yml')
  const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [protectedPath] })
  expect(args).not.toContain(root)
})

it('writes a sibling workspace through the native bubblewrap runner', ({ skip }) => {
  const root = mkdtempSync(join(homedir(), '.sandbox-native-siblings-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: workspace }), '--', 'true'])
  if (probe.status !== 0) skip('bubblewrap cannot create a sandbox on this host')
  const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [join(root, 'host', 'config.yml')] })
  const result = spawnSync('bwrap', [...args, '--', 'sh', '-c', 'printf allowed > "$1"', 'sh', join(workspace, 'output')], { encoding: 'utf8' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(readFileSync(join(workspace, 'output'), 'utf8')).toBe('allowed')
})

it('protects an absent input with an unwritable mount while retaining writable siblings', () => {
  const root = mkdtempSync(join(homedir(), '.sandbox-missing-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const input = join(root, 'host', 'config.yml')
  const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: root, protectedPaths: [input] })
  expect(args.join('\n')).toContain(['--tmpfs', input, '--remount-ro', input].join('\n'))
  expect(args.join('\n')).toContain(['--bind', root, root].join('\n'))
  expect(args.join('\n')).not.toContain(['--ro-bind', root, root].join('\n'))
})
