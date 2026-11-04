/** Native socket controls use only test-owned listeners and an isolated tmux server. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { bwrapProfileArgs, landlockProfileArgs } from '../src/profiles.ts'
import { buildLandlockLauncher } from './landlock-launcher.ts'

const connect = 'const net=require("node:net"); const s=net.connect(process.argv[1]); s.on("connect",()=>{s.end();process.exit(0)});s.on("error",e=>{console.error(e.code);process.exit(1)});'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-native-'))
  onTestFinished(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
  return root
}

async function listen(path: string) {
  const server = createServer((socket) => { socket.end() })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
}

function run(argv: string[]) {
  return spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 5_000 })
}

function nativeBwrap(required: string | undefined): string | undefined {
  const probe = run(['bwrap', '--ro-bind', '/', '/', '--', '/bin/true'])
  if (probe.status === 0) return undefined
  const reason = `native bubblewrap unavailable: ${probe.error?.message ?? probe.stderr.trim()}; status=${probe.status}`
  if (required === 'required') throw new Error(reason)
  console.info(reason)
  return reason
}

it('required native mode refuses an unavailable bubblewrap', () => {
  const reason = nativeBwrap(undefined)
  if (reason !== undefined) expect(() => nativeBwrap('required')).toThrow(reason)
})

for (const mode of ['read-only', 'workspace-write'] as const) {
  it(`native bubblewrap masks test session sockets in ${mode}`, async ({ skip }) => {
    const reason = nativeBwrap(process.env.PANEDESK_CI_NATIVE_SANDBOX)
    if (reason !== undefined) skip(reason)
    const root = fixture()
    const sessions = join(root, 'sessions')
    const workspace = join(root, 'workspace')
    mkdirSync(sessions)
    mkdirSync(workspace)
    vi.stubEnv('XDG_RUNTIME_DIR', sessions)
    vi.stubEnv('TMUX_TMPDIR', sessions)
    const args = bwrapProfileArgs({ mode, workspaceRoot: workspace })
    for (const name of ['bus', 'X11', 'wayland-0']) {
      const path = join(sessions, name)
      await listen(path)
      const command = [process.execPath, '-e', connect, path]
      const control = run(['bwrap', '--ro-bind', '/', '/', '--', ...command])
      expect(control.status, control.stderr).toBe(0)
      const isolated = run(['bwrap', ...args, '--', ...command])
      expect(isolated.status, isolated.stderr).toBe(1)
      expect(isolated.stderr.trim()).toBe('ENOENT')
      console.info(`${mode} ${name}: unmasked=0 masked=${isolated.status}`)
    }
    const tmuxSocket = join(sessions, 'tmux.sock')
    const started = run(['tmux', '-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'isolated-test', '-P', '-F', '#{pid}'])
    expect(started.status, started.stderr).toBe(0)
    const serverPid = Number(started.stdout.trim())
    onTestFinished(() => { const stopped = run(['tmux', '-S', tmuxSocket, 'kill-server']); expect(stopped.status, `test server ${serverPid}: ${stopped.stderr}`).toBe(0) })
    expect(Number.isSafeInteger(serverPid) && serverPid > 0).toBe(true)
    const command = ['tmux', '-S', tmuxSocket, 'send-keys', '-t', 'isolated-test', 'true', 'Enter']
    const control = run(['bwrap', '--ro-bind', '/', '/', '--', ...command])
    expect(control.status, control.stderr).toBe(0)
    const isolated = run(['bwrap', ...args, '--', ...command])
    expect(isolated.status, isolated.stderr).not.toBe(0)
    console.info(`${mode} tmux: unmasked=0 masked=${isolated.status}`)
  })
}

it('Landlock-only still connects to pathname sockets', async ({ skip }) => {
  if (process.platform !== 'linux') skip('Landlock requires Linux')
  const root = fixture()
  const path = join(root, 'bus')
  await listen(path)
  const result = run([buildLandlockLauncher(), ...landlockProfileArgs({ mode: 'read-only', workspaceRoot: root }), '--', process.execPath, '-e', connect, path])
  expect(result.status, result.stderr).toBe(0)
  console.info('Landlock-only pathname socket: connected; known limitation')
})

it('Landlock scope denies abstract UNIX connections from both launcher modes', async ({ skip }) => {
  if (process.platform !== 'linux') skip('Landlock requires Linux')
  const root = fixture()
  const probe = run(['python3', '-I', '-c', 'import ctypes; print(ctypes.CDLL(None).syscall(444,0,0,1))'])
  expect(probe.status, probe.stderr).toBe(0)
  const abi = Number(probe.stdout.trim())
  console.info(`Landlock ABI=${abi}`)
  if (abi < 6) skip('abstract UNIX scope requires Landlock ABI >= 6; command startup remains available')
  const address = `\0session-${process.pid}-${root.split('/').pop()}`
  await listen(address)
  const client = 'const net=require("node:net");const s=net.connect("\\0"+process.argv[1]);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",e=>{console.error(e.code);process.exit(1)});'
  const command = [process.execPath, '-e', client, address.slice(1)]
  expect(run(command).status).toBe(0)
  const launcher = buildLandlockLauncher()
  for (const flags of [['--scope-only'], ['--ro', '/']]) {
    const result = run([launcher, ...flags, '--', ...command])
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr.trim()).toBe('EPERM')
  }
  const reason = nativeBwrap(process.env.PANEDESK_CI_NATIVE_SANDBOX)
  if (reason !== undefined) {
    console.info(`${reason}; bwrap nested scope remains for native CI`)
    return
  }
  // The test-owned launcher workspace is rebound read-only inside private /tmp.
  const result = run(['bwrap', ...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: dirname(launcher) }), '--', launcher, '--scope-only', '--', ...command])
  expect(result.status, result.stderr).toBe(1)
  expect(result.stderr.trim()).toBe('EPERM')
})
