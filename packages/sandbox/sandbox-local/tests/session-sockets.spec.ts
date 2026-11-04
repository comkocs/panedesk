/** Session socket isolation is distinct from read-only filesystem grants. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { bwrapProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'
import { buildLandlockLauncher } from './landlock-launcher.ts'

afterEach(() => { vi.unstubAllEnvs() })

for (const mode of ['read-only', 'workspace-write'] as const) {
  it(`isolates session directories and environment in ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'session-profile-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const runtime = join(root, 'runtime')
    const tmux = join(root, 'tmux')
    mkdirSync(runtime)
    mkdirSync(tmux)
    vi.stubEnv('XDG_RUNTIME_DIR', runtime)
    vi.stubEnv('TMUX_TMPDIR', tmux)
    const args = bwrapProfileArgs({ mode, workspaceRoot: '/workspace', protectedPaths: ['/tmp/host-input'] })
    for (const path of ['/tmp', `/run/user/${process.getuid!()}`, '/run/screen', runtime, tmux]) {
      expect(args.join('\n')).toContain(`--tmpfs\n${path}`)
    }
    for (const key of ['TMUX', 'TMUX_TMPDIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY']) {
      expect(args.join('\n')).toContain(`--unsetenv\n${key}`)
    }
    expect(args.join('\n')).toContain(`--setenv\nXDG_RUNTIME_DIR\n/run/user/${process.getuid!()}`)
    expect(args).not.toContain('--unshare-net')
  })
}

it('masks temporary sessions after an ancestor workspace and protected mounts', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-protected-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/', protectedPaths: [root] })
  const lastTemp = args.lastIndexOf('/tmp')
  const protectedMount = args.indexOf(root)
  expect(protectedMount).toBeGreaterThan(0)
  // Environment arguments also contain /tmp; locate the final tmpfs instead.
  const mounts = args.flatMap((value, index) => value === '--tmpfs' && args[index + 1] === '/tmp' ? [index] : [])
  expect(mounts).toHaveLength(2)
  expect(mounts[1]).toBeGreaterThan(protectedMount)
  expect(lastTemp).toBeGreaterThan(mounts[1]!)
})

it('keeps session masks authoritative when runtime overlaps the workspace', () => {
  vi.stubEnv('XDG_RUNTIME_DIR', '/workspace')
  const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/workspace' })
  expect(args.join('\n')).toContain('--perms\n0700\n--tmpfs\n/workspace')
  expect(args.lastIndexOf('/workspace')).toBeGreaterThan(args.indexOf('--bind'))
})

it('denies Seatbelt outbound UNIX sockets without denying ordinary temporary reads', () => {
  const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/workspace' })[1]!
  for (const root of ['/tmp', '/private/tmp']) {
    expect(profile).toContain(`(deny network-outbound (remote unix-socket (path-prefix "${root}/")))`)
  }
  expect(profile).not.toContain('(deny file-read* (subpath "/tmp"))')
})

it('the native scope-only launcher keeps ordinary commands available', () => {
  const result = spawnSync(buildLandlockLauncher(), ['--scope-only', '--', '/bin/true'], { encoding: 'utf8', timeout: 5_000 })
  expect(result.status, result.stderr).toBe(0)
})
