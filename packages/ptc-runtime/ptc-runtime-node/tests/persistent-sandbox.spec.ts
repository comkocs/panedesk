import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { setSandboxMode } from '@panedesk/dsh-sandbox-policy'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@panedesk/dsh-session'
import { Context } from '@panedesk/cordis'
import { SandboxUnavailableError } from '@panedesk/dsh-sandbox'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountRuntime } from './setup.ts'

async function setup(mode: 'read-only' | 'workspace-write' = 'read-only', executionMode: 'per-call' | 'persistent-in-memory' = 'persistent-in-memory') {
  const root = await mkdtemp(join(homedir(), '.panedesk-persistent-sandbox-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const { runtime } = await mountRuntime(ctx, { executionMode }, { mode, workspaceRoot: cwd })
  const owner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))
  return { root, cwd, ctx, runtime, owner, run }
}

it.for(['per-call', 'persistent-in-memory'] as const)('starts %s Node with protected inputs read-only and ordinary workspace writes allowed', async (executionMode, { skip }) => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--', 'true'])
  if (probe.status !== 0) skip('native bubblewrap unavailable')
  const { ctx, cwd, runtime, owner } = await setup('workspace-write', executionMode)
  const input = join(cwd, 'plugin.mjs')
  await writeFile(input, 'owner')
  const sandbox = ctx.sandbox
  if (!(sandbox instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  sandbox.internals = { platform: 'linux', probeBwrap: () => true }
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { spawn.mockRestore() })
  const policy = { mode: 'workspace-write', workspaceRoot: cwd, protectedPaths: [input] } as const
  const allowed = await runtime.run(runtime.resolve({
    program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(cwd, 'ordinary.txt'))}, 'allowed')`,
    bindings: [], stateOwner: owner, sandboxPolicy: policy,
  }))
  expect(allowed.error).toBeUndefined()
  expect(await readFile(join(cwd, 'ordinary.txt'), 'utf8')).toBe('allowed')
  const argv = spawn.mock.calls[0]![0].argv
  expect(argv[0]).toBe('bwrap')
  expect(argv.join('\n')).toContain(['--bind', cwd, cwd].join('\n'))
  expect(argv.join('\n')).toContain(['--ro-bind', input, input].join('\n'))
  const denied = await runtime.run(runtime.resolve({
    program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(input)}, 'model')`,
    bindings: [], stateOwner: owner, sandboxPolicy: policy,
  }))
  expect(denied.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect(await readFile(input, 'utf8')).toBe('owner')
})

it('retains variables under read-only confinement and denies writes across calls', async () => {
  const { cwd, run } = await setup()
  expect((await run('const fsp = await import("node:fs/promises"); var count = 1;')).error).toBeUndefined()
  expect((await run('++count')).value).toBe(2)
  const result = await run('await fsp.writeFile("denied.txt", String(count))')
  expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await run('count')).value).toBe(2)
})

it('retains workspace write access while refusing a sibling path', async () => {
  const { root, cwd, run } = await setup('workspace-write')
  expect((await run('const fsp = await import("node:fs/promises"); await fsp.writeFile("inside.txt", "allowed")')).error).toBeUndefined()
  const result = await run(`await fsp.writeFile(${JSON.stringify(join(root, 'outside.txt'))}, "denied")`)
  expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect(await readFile(join(cwd, 'inside.txt'), 'utf8')).toBe('allowed')
  await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses reuse under another policy until the owner has been released', async () => {
  const { cwd, runtime, owner, run } = await setup()
  expect((await run('var retained = 42;')).error).toBeUndefined()
  const spec = runtime.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: cwd } })
  await expect(runtime.run(spec)).rejects.toThrow('release the retained environment')
  await runtime.release(owner)
  expect((await runtime.run(spec)).value).toBe('undefined')
})

it('fails closed when confinement is unavailable without spawning Node', async () => {
  const { ctx, run } = await setup()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(new SandboxUnavailableError('read-only'))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { confine.mockRestore(); spawn.mockRestore() })
  expect((await run('42')).error?.kind).toBe('sandbox-unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it('cancels a pending confinement operation before spawning', async () => {
  const { ctx, runtime, owner } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const confinement = Promise.withResolvers<Awaited<ReturnType<typeof ctx.sandbox.confine>>>()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(() => { entered.resolve(undefined); return confinement.promise })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const controller = new AbortController()
  const pending = runtime.run(runtime.resolve({ program: '42', bindings: [], stateOwner: owner, signal: controller.signal }))
  try {
    await entered.promise
    controller.abort()
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    expect((await pending).error?.kind).toBe('abort')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await pending
    confine.mockRestore()
    spawn.mockRestore()
  }
})

it('clears a registered live REPL through the file-policy setter before starting under the new mode', async () => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write')
  const session = ctx.sessions.create(SessionId('retained-policy-change'), { meta: { cwd } })
  const run = (program: string) => runtime.run(runtime.resolve({
    program, bindings: [], stateOwner: owner, sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
  }))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { spawn.mockRestore() })
  expect((await run('const retained = 7; retained')).value).toBe(7)
  const started = spawn.mock.results[0]
  if (started?.type !== 'return') throw new Error('the retained process did not start')
  setSandboxMode(session, 'read-only')
  await started.value.done
  expect((await run('typeof retained')).value).toBe('undefined')
  const denied = await run('await (await import("node:fs/promises")).writeFile("denied-after-switch.txt", "denied")')
  expect(denied.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  await expect(readFile(join(cwd, 'denied-after-switch.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps a one-shot wider policy separate from standing variables and subsequent writes', async () => {
  const { ctx, cwd, runtime, owner } = await setup()
  const session = ctx.sessions.create(SessionId('temporary-policy'), { meta: { cwd } })
  const standing = ctx.sandboxPolicy.resolve({ session })
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner, sandboxPolicy: standing }))
  expect((await run('const retained = 7; retained')).value).toBe(7)
  const result = await runtime.run(runtime.resolve({
    program: 'const temporary = 9; await (await import("node:fs/promises")).writeFile("elevated.txt", typeof retained); temporary',
    bindings: [], sandboxPolicy: { ...standing, mode: 'danger-full-access' },
  }))
  expect(result.value).toBe(9)
  expect(await readFile(join(cwd, 'elevated.txt'), 'utf8')).toBe('undefined')
  expect((await run('({ retained, temporary: typeof temporary })')).value).toEqual({ retained: 7, temporary: 'undefined' })
  expect((await run('await (await import("node:fs/promises")).writeFile("denied.txt", "denied")')).sandbox?.denied).toBe(true)
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
})

it('preserves the current execution context for bindings in a reused REPL', async () => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write')
  const session = ctx.sessions.create(SessionId('binding-context'), { meta: { cwd } })
  const context = new AsyncLocalStorage<string>()
  const run = (program: string) => runtime.run(runtime.resolve({ program, stateOwner: owner,
    sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    bindings: [{ global: 'tools', functions: { current: async () => context.getStore() ?? null } }],
  }))
  expect((await context.run('first', () => run('var retained = await tools.current({}); retained'))).value).toBe('first')
  expect((await context.run('second', () => run('await tools.current({})'))).value).toBe('second')
})

it.each(['per-call', 'persistent-in-memory'] as const)('cancels active %s execution after a synchronous policy change', async (executionMode) => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write', executionMode)
  const session = ctx.sessions.create(SessionId(`active-${executionMode}`), { meta: { cwd } })
  const entered = Promise.withResolvers<undefined>()
  const pending = runtime.run(runtime.resolve({ program: 'await tools.ready({}); await new Promise(() => {})',
    stateOwner: owner, sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    bindings: [{ global: 'tools', functions: { ready: async () => { entered.resolve(undefined); return null } } }],
  }))
  await entered.promise
  setSandboxMode(session, 'read-only')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  expect((await pending).error?.kind).toBe('abort')
})
