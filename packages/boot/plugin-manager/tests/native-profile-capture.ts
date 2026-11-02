/** Capture native hand-offs without executing a platform sandbox on the test host. */
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { expect, vi } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { canonicalPath, rootsOverlap } from '@panedesk/dsh-sandbox'
import type { ProtectedInputEnforcement } from '@panedesk/dsh-sandbox'
import Subprocess from '@panedesk/dsh-subprocess-local'
import Bash from '@panedesk/dsh-bash-sandbox'
import Pwsh from '@panedesk/dsh-pwsh-sandbox'
import NodeRuntime from '@panedesk/dsh-ptc-runtime-node'
import { BashTerminalBackend } from '@panedesk/dsh-terminal-bash'
import { Config, resolveConfig } from '@panedesk/dsh-terminal-bash/src/config.ts'
import { TerminalSessionId } from '@panedesk/dsh-terminal'
import type { SubprocessTerminalHandle } from '@panedesk/dsh-subprocess'

/** Platform authorization calls, observed at the native ACL adapter. */
export interface WriteAce { path: string; sid: string; standing: boolean; deny?: 'writes' | 'delete' }

/** Assert the actual argv and ACL list prepared for a native backend.
 * @param platform Injected backend platform.
 * @param argv Exact subprocess hand-off, not separately regenerated arguments.
 * @param protectedPaths Current protected host inputs.
 * @param grants Calls to the native ACL adapter during confinement.
 * @param workspace Writable workspace whose unrelated children remain writable.
 * @param records Per-input native protection or required host validation from the same hand-off.
 */
export function assertNativeProfile(
  platform: string, argv: readonly string[], protectedPaths: readonly string[], grants: readonly WriteAce[], workspace: string,
  records: readonly ProtectedInputEnforcement[],
): void {
  expect(argv.length).toBeGreaterThan(3)
  if (platform === 'linux') {
    expect(argv[0]).toBe('bwrap')
    const mounts: { kind: string; path: string }[] = []
    for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
      const kind = argv[i]
      if (kind === '--bind' || kind === '--ro-bind') {
        mounts.push({ kind, path: argv[i + 2]! }); i += 2
      } else if (kind === '--tmpfs' || kind === '--dev' || kind === '--proc') {
        mounts.push({ kind, path: argv[++i]! })
      } else if (kind === '--remount-ro') {
        mounts.push({ kind: '--ro-bind', path: argv[++i]! })
      }
    }
    expect(mounts[0]).toEqual({ kind: '--ro-bind', path: '/' })
    for (const root of protectedPaths) {
      const record = records.find(record => record.path === root)
      expect(record, `missing protection record for ${root}`).toBeDefined()
      if (record?.enforcement === 'host-fallback') {
        expect(record.reason).toMatch(/^(unrepresentable|link-name)$/u)
        continue
      }
      const covering = mounts.filter(mount => root === mount.path || root.startsWith(`${mount.path === '/' ? '' : mount.path}/`))
      expect(covering.at(-1), `writable mount covers ${root}`).toMatchObject({ kind: '--ro-bind' })
    }
    const ordinary = join(workspace, 'ordinary-output.txt')
    const covering = mounts.filter(mount => ordinary === mount.path || ordinary.startsWith(`${mount.path === '/' ? '' : mount.path}/`))
    expect(covering.at(-1)).toMatchObject({ kind: '--bind', path: workspace })
  } else if (platform === 'darwin') {
    expect(argv[0]).toBe('sandbox-exec')
    const profile = argv[argv.indexOf('-p') + 1]!
    expect(profile).toContain('(deny file-write*)')
    const allows = [...profile.matchAll(/\(allow file-write\* ((?:\((?:subpath|literal) "(?:\\.|[^"\\])*"\)\s*)+)\)/gu)]
      .flatMap(match => [...match[1]!.matchAll(/\((?:subpath|literal) ("(?:\\.|[^"\\])*")\)/gu)]
        .map(path => String(JSON.parse(path[1]!))))
    expect(allows.length).toBeGreaterThan(0)
    expect(allows).toContain(workspace)
    for (const root of protectedPaths) {
      expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(root)}))`)
    }
    expect(profile).not.toContain(`(deny file-write* (subpath ${JSON.stringify(workspace)}))`)
  } else {
    expect(platform).toBe('win32')
    expect(argv).toContain('--write-sid')
    expect(argv).toContain('--temp-write-sid')
    expect(grants.some(grant => grant.standing)).toBe(true)
    expect(grants.some(grant => !grant.standing)).toBe(true)
    expect(grants).toContainEqual(expect.objectContaining({ path: workspace, standing: true }))
    for (const root of protectedPaths) {
      const overlaps = grants.filter(grant => grant.deny === undefined && rootsOverlap(grant.path, root))
      if (overlaps.length > 0 && existsSync(root)) {
        expect(grants).toContainEqual(expect.objectContaining({ path: root, deny: 'writes' }))
      }
      expect(argv).toContain(root)
    }
    expect(grants.some(grant => grant.path === workspace && grant.deny === 'writes')).toBe(false)
    for (const grant of grants) expect(argv).toContain(grant.sid)
  }
}

/** Exercise a real process consumer and inspect the exact native hand-off.
 * @param host Live host supplying policy and consumers.
 * @param agent Model caller after owner consent.
 * @param entry Process entry from the matrix.
 * @param target Protected destination in the attempted program.
 * @param platform Native backend selected through platform injection.
 * @param grants ACL adapter calls captured by the owning spec.
 * @param protectedPaths Inputs observed before the test-only protection control.
 */
export async function captureProcessProfile(
  host: Context, agent: Agent, entry: string, target: string, platform: string, grants: WriteAce[], protectedPaths: readonly string[],
): Promise<void> {
  const providerFiber = await host.plugin(LocalSandboxProvider)
  const provider = host.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Expected local sandbox provider')
  provider.internals = { platform, probeBwrap: () => true, windowsAclRunnerArgs: ['native-acl-runner'] }
  const policy = host.sandboxPolicy.resolve({ session: agent.session })
  expect(policy.mode).toBe('workspace-write')
  const paths = protectedPaths
  expect(paths.some(path => rootsOverlap(path, target))).toBe(true)
  const subprocessFiber = await host.plugin(Subprocess)
  let handed: readonly string[] | undefined
  let records: readonly ProtectedInputEnforcement[] = []
  const confine = provider.confine.bind(provider)
  const capture = vi.spyOn(provider, 'confine').mockImplementation(async (...args) => {
    const result = await confine(...args)
    records = result.protectedInputs ?? []
    return result
  })
  const stop = new Error('Native backend unavailable: captured invocation only')
  const spawn = vi.spyOn(host.subprocess, 'spawn').mockImplementation((spec) => { handed = [...spec.argv]; throw stop })
  let consumer: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    if (entry.startsWith('terminal-')) {
      const completion = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const output = new PassThrough()
      const writes: string[] = []
      const terminal: SubprocessTerminalHandle = {
        pid: 1, output, done: completion.promise,
        write: async (text) => { writes.push(text); output.write('\x1b]133;D;0\x07dsh> ') }, resize: async () => {},
        inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
        inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
        signalForeground: async () => 1,
        terminate: async () => { output.end(); completion.resolve({ exitCode: 0, signal: null }) },
      }
      const config = resolveConfig(Config({ timeoutMs: 1000, pollIntervalMs: 5, idleSilenceMs: 10, handoffGraceMs: 5 }))
      const backend = new BashTerminalBackend(host, config, async (spec) => {
        handed = [...spec.argv]
        setImmediate(() => output.write('\x1b]133;D;0\x07dsh> '))
        return terminal
      })
      const session = await backend.spawn({
        sessionId: TerminalSessionId('matrix-terminal'), owner: agent, type: 'shell', cwd: policy.workspaceRoot,
      })
      try {
        if (entry === 'terminal-input') {
          await session.startSend({ text: `printf model > ${JSON.stringify(target)}`, submit: true }).done
          expect(writes.join('')).toContain(target)
        }
      } finally { await session.close('profile captured') }
    } else if (entry === 'run_code') {
      consumer = await host.plugin(NodeRuntime, { timeoutMs: 1000 })
      const result = await host.ptcRuntime.run(host.ptcRuntime.resolve({
        program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'model')`,
        bindings: [], sandboxPolicy: policy, cwd: policy.workspaceRoot,
      }))
      expect(result.error?.message).toContain(stop.message)
    } else {
      const pwsh = entry.startsWith('pwsh')
      consumer = pwsh ? await host.plugin(Pwsh, { pwshPath: 'pwsh', graceMs: 10 })
        : await host.plugin(Bash, { bashPath: '/bin/bash', graceMs: 10 })
      const command = pwsh ? `Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value model`
        : `printf model > '${target.replaceAll("'", "'\\''")}'`
      const spec = host.shell.resolve({ command, workdir: policy.workspaceRoot, sandboxPolicy: policy,
        onExpiry: entry.endsWith('background') ? 'none' : 'kill' })
      try { await host.shell.execute(spec) }
      catch (error) { expect(error).toBe(stop) }
    }
    expect(handed).toBeDefined()
    if (process.env.TEST_CAPTURE_NATIVE_PROFILES === '1') {
      console.info(JSON.stringify({ entry, platform, argv: handed, grants, protectedPaths: paths }))
    }
    assertNativeProfile(platform, handed!, paths, grants, canonicalPath(policy.workspaceRoot), records)
  } finally {
    capture.mockRestore()
    spawn.mockRestore()
    await consumer?.dispose()
    await subprocessFiber.dispose()
    await providerFiber.dispose()
  }
}
