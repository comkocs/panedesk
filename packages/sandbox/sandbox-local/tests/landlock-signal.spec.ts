/** Native signal isolation against the published CLI, without credentials or model calls. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Context } from '@panedesk/cordis'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildLandlockLauncher } from './landlock-launcher.ts'

function ownChild(child: ChildProcess) {
  const closed = once(child, 'close')
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  return closed
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'landlock-signal-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const launcher = buildLandlockLauncher()
  // Query the kernel independently: a successful kill must never be mistaken for an old ABI.
  const probeSource = join(root, 'abi.c')
  const probeBinary = join(root, 'abi')
  writeFileSync(probeSource, '#define _GNU_SOURCE\n#include <stdio.h>\n#include <unistd.h>\n#include <sys/syscall.h>\nint main(void) { long abi = syscall(SYS_landlock_create_ruleset, 0, 0, 1); printf("%ld\\n", abi); return abi < 0; }\n')
  const compiled = spawnSync('cc', [probeSource, '-o', probeBinary], { encoding: 'utf8' })
  expect(compiled.status, compiled.stderr).toBe(0)
  const probed = spawnSync(probeBinary, [], { encoding: 'utf8' })
  expect(probed.status, probed.stderr).toBe(0)
  const abi = Number(probed.stdout.trim())
  expect(abi).toBeGreaterThanOrEqual(1)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSandboxProvider)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => false, landlockLauncher: launcher }
  const confine = async (command: readonly string[]) => {
    const result = await sandbox.confine(command, { mode: 'workspace-write', workspaceRoot: root })
    expect(result.argv[0]).toBe(launcher)
    return result.argv
  }
  return { root, abi, confine }
}

async function host(root: string) {
  const profile = join(root, 'profiles', 'signal-test')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'signal-test-profile', private: true, dsh: { profile: { bundles: [] } },
  }))
  const plugin = new URL('../../../../apps/cli/tests/fixtures/signal-host.mjs', import.meta.url).href
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: signal-host\n      name: ${JSON.stringify(plugin)}\n`)
  const entry = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
  const child = spawn(process.execPath, ['--inspect-port=0', entry, '--profile', 'signal-test'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), PANEDESK_HOME: root, PANEDESK_TELEMETRY_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = ownChild(child)
  let inspectorListening = false
  child.stderr.on('data', (chunk: Buffer) => {
    inspectorListening ||= chunk.toString().includes('Debugger listening')
  })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(() => { lines.close() })
  const replies = lines[Symbol.asyncIterator]()
  const next = async (): Promise<Record<string, unknown>> => {
    const line = await Promise.race([
      replies.next(),
      closed.then(() => { throw new Error('Signal fixture exited before replying') }),
    ])
    if (line.done) throw new Error('Signal fixture output closed before replying')
    return JSON.parse(line.value) as Record<string, unknown>
  }
  const ready = await next()
  expect(ready.ready).toBe(true)
  expect(ready.pid).toBe(child.pid)
  const inspect = async () => {
    child.stdin.write('inspect\n')
    return (await next()).inspector
  }
  return { child, closed, ready, inspect, listening: () => inspectorListening }
}

const signalSource = "try { process.kill(Number(process.argv[1]), 'SIGUSR1'); console.log('sent') } catch (error) { console.log(error.code) }"

describe.skipIf(process.platform !== 'linux')('Landlock-only host signal isolation', () => {
  it('blocks sandbox SIGUSR1 from activating the CLI Inspector and rejects the signal on ABI 6', async () => {
    const f = await fixture()
    const target = await host(f.root)
    const argv = await f.confine([process.execPath, '-e', signalSource, String(target.child.pid)])
    const sent = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 5000, env: {} })
    expect(sent.error).toBeUndefined()
    expect(sent.status).toBe(0)
    const inspector = await target.inspect()
    console.log(JSON.stringify({ abi: f.abi, signal: sent.stdout.trim(), inspector, listening: target.listening() }))
    expect.soft(inspector).toBe(false)
    expect.soft(target.listening()).toBe(false)
    expect(sent.stdout.trim()).toBe(f.abi >= 6 ? 'EPERM' : 'sent')
    target.child.kill('SIGTERM')
    expect(await target.closed).toEqual([0, null])
  })

  it('disables signal activation before the CLI profile starts even without Landlock', async () => {
    const f = await fixture()
    const target = await host(f.root)
    target.child.kill('SIGUSR1')
    expect.soft(await target.inspect()).toBe(false)
    expect.soft(target.listening()).toBe(false)
    expect(target.ready.args).toContain('--disable-sigusr1')
    target.child.kill('SIGTERM')
    expect(await target.closed).toEqual([0, null])
  })

  it('preserves host SIGTERM cancellation of a sandboxed child', async () => {
    const f = await fixture()
    const argv = await f.confine([process.execPath, '-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"])
    const child = spawn(argv[0]!, argv.slice(1), { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = ownChild(child)
    await once(child.stdout, 'data')
    expect(child.kill('SIGTERM')).toBe(true)
    expect(await closed).toEqual([null, 'SIGTERM'])
  })
})
