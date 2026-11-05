import { Context } from '@panedesk/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionSourceRegistry } from '@panedesk/dsh-client-connection/src/connection-source.ts'
import { LinuxProductGroups, LINUX_SOURCE_LIMITATION } from '../src/linux-product-groups.ts'
import { WindowsProductJobs } from '../src/windows-product-jobs.ts'
import LocalSubprocessRuntime from '../src/index.ts'

const host = vi.hoisted(() => ({
  spawn: vi.fn<typeof import('../src/spawn.ts').spawnSubprocess>(),
  terminal: vi.fn(), identity: vi.fn(),
}))
vi.mock('@panedesk/node-addon-system/socket-cgroup', () => ({
  loadSocketCgroupQuery: () => ({ probe: () => true, query: () => 1n }),
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs, accessSync: () => {},
    readFileSync: (path: string, ...args: never[]) => path === '/proc/self/cgroup' ? '0::/synthetic\n' : fs.readFileSync(path, ...args),
    mkdtempSync: (prefix: string) => prefix.startsWith('/sys/fs/cgroup') ? '/sys/fs/cgroup/synthetic/probe' : fs.mkdtempSync(prefix),
    rmdirSync: (path: string) => { if (!path.startsWith('/sys/fs/cgroup')) fs.rmdirSync(path) },
  }
})
vi.mock('../src/windows-job.ts', () => ({ probeWindowsJob: () => false }))
vi.mock('../src/windows-inspector.ts', () => ({ readWindowsProcessIdentity: host.identity }))
vi.mock('../src/spawn.ts', async original => ({
  ...await original<typeof import('../src/spawn.ts')>(), spawnSubprocess: host.spawn,
}))
vi.mock('@panedesk/dsh-lazy-require', () => ({
  createLazyRequire: () => () => ({ spawn: host.terminal }),
}))

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it('cleans inherited product locators before a Windows fallback and uses Windows identity inspection', async () => {
  const ctx = new Context()
  const jobs = WindowsProductJobs.forHost(ctx)
  const classify = vi.spyOn(jobs, 'classify').mockReturnValue('unknown')
  vi.spyOn(WindowsProductJobs, 'forHost').mockReturnValue(jobs)
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const registry = new ConnectionSourceRegistry(ctx)
  const stopped = new Error('Fallback launch stopped')
  host.spawn.mockImplementation(() => { throw stopped })
  const identity = { pid: 123, startIdentity: '1:2', startedAt: 1234 }
  host.identity.mockReturnValue(identity)
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    platform.mockRestore()
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    runtime.internals = { platform: 'win32' }
    const connectionPlatform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(registry.classify(undefined)).toBe('unknown')
    expect(classify).toHaveBeenCalledOnce()
    connectionPlatform.mockRestore()
    expect(() => runtime.spawn({
      argv: ['trusted-runner'], cwd: process.cwd(), graceMs: 1,
      env: {
        ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
        DSH_WINDOWS_PRODUCT_JOB: 'inherited-job', dsh_windows_product_job: 'alias', NORMAL: 'kept',
      },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })).toThrow(stopped)
    expect(host.spawn.mock.calls[0]?.[0].env).toEqual({ NORMAL: 'kept' })
    const inspection = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(runtime.readProcessIdentity(123)).toBe(identity)
    expect(host.identity).toHaveBeenCalledExactlyOnceWith(123)
    inspection.mockRestore()
  } finally { await ctx.fiber.dispose() }
})

it.each([false, true])('classifies Linux connections and warns once for product terminal fallback with attribution available: %s', async (available) => {
  const ctx = new Context()
  const groups = LinuxProductGroups.probe()
  if (available && groups === undefined) throw new Error('Attribution fixture must be available')
  vi.spyOn(LinuxProductGroups, 'forHost').mockReturnValue(available ? groups : undefined)
  const classify = groups === undefined ? undefined : vi.spyOn(groups, 'classify').mockReturnValue('product-sandbox')
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const registry = new ConnectionSourceRegistry(ctx)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const stopped = new Error('Terminal allocation stopped')
  host.terminal.mockImplementation(() => { throw stopped })
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    platform.mockRestore()
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    runtime.internals = { platform: 'darwin' }
    runtime.terminalInspector = {
      foregroundPgid: () => undefined, isStdinWaiting: () => false,
      snapshot: () => ({ tree: () => [], session: () => [], alive: () => false }),
      isAlive: () => false, signalGroup: () => {}, signalProcess: () => {},
    }
    const connectionPlatform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(registry.classify(undefined)).toBe(available ? 'product-sandbox' : 'non-product')
    if (available) expect(classify).toHaveBeenCalledOnce()
    connectionPlatform.mockRestore()
    const spec = { argv: ['trusted-runner'], cwd: process.cwd(), graceMs: 1, rows: 24, cols: 80, terminalType: 'dumb' }
    await expect(runtime.spawnTerminal(spec)).rejects.toThrow(stopped)
    for (let index = 0; index < 2; index++) {
      await expect(runtime.spawnTerminal({ ...spec, productSandbox: true })).rejects.toThrow(stopped)
    }
    expect(warn.mock.calls.filter(([message]) => message === LINUX_SOURCE_LIMITATION)).toEqual([[LINUX_SOURCE_LIMITATION]])
  } finally { await ctx.fiber.dispose() }
})
