import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@panedesk/dsh-subprocess'
import type { LinuxScopeInternals } from '../src/linux-scope.ts'
import type { ManagedProcessLaunch } from '../src/managed-owner.ts'

const host = vi.hoisted(() => ({
  probe: vi.fn(() => true), manager: vi.fn(() => true), native: vi.fn(() => []),
  launch: vi.fn<(_spec: SubprocessSpawnSpec, _env: Record<string, string>,
    _argv: readonly string[], options: LinuxScopeInternals) => ManagedProcessLaunch>(),
  releases: [] as Array<() => void>,
}))
const group = '/sys/fs/cgroup/session/product-test.scope/panedesk-product'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    accessSync: vi.fn(),
    mkdtempSync: (path: string) => path.startsWith('/sys/fs/cgroup/') ? `${path}fixture` : fs.mkdtempSync(path),
    rmdirSync: vi.fn(),
    readFileSync: (path: string, ...args: never[]) => {
      if (path === '/proc/self/cgroup') return '0::/session\n'
      if (path === '/proc/321/cgroup') return '0::/session/product-test.scope/panedesk-product\n'
      if (path === '/scope-fixture/cgroup-ready.json') return JSON.stringify({ pid: 321 })
      if (path.endsWith('/cgroup.events')) return 'populated 0\n'
      return fs.readFileSync(path, ...args)
    },
    existsSync: (path: string) => path === '/scope-fixture/cgroup-ready.json' || fs.existsSync(path),
    statSync: (path: string, ...args: never[]) => path === group ? { ino: 10n } : fs.statSync(path, ...args),
    readdirSync: (path: string, ...args: never[]) => path === group ? [] : fs.readdirSync(path, ...args),
    writeFileSync: (path: string, ...args: Parameters<typeof fs.writeFileSync> extends [unknown, ...infer Rest] ? Rest : never) => {
      if (!path.startsWith('/scope-fixture/')) fs.writeFileSync(path, ...args)
    },
    renameSync: vi.fn(),
  }
})
vi.mock('@panedesk/node-addon-system/socket-cgroup', () => ({
  loadSocketCgroupQuery: () => ({ probe: host.probe, query: () => 10n }),
}))
vi.mock('../src/linux-scope.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/linux-scope.ts')>(),
  probeLinuxNative: host.native,
  confirmLinuxManager: host.manager,
  linuxManagerListener: () => 'manager',
  systemdRunIdentity: () => 'launcher',
  launchLinuxScope: host.launch,
}))

import LocalSubprocessRuntime from '../src/index.ts'
import { LinuxProductGroups, LINUX_SOURCE_LIMITATION } from '../src/linux-product-groups.ts'

function command(productSandbox?: true): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', 'process.stdout.write("started")'], cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024, spill: { maxBytes: 1024 } }, stderr: 'inherit' },
    graceMs: 100, ...productSandbox === undefined ? {} : { productSandbox },
  }
}

afterEach(() => {
  for (const release of host.releases.splice(0)) release()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('product scope registration wiring', () => {
  it.each([false, true])('registers only with a usable scope: %s', async (available) => {
    const home = mkdtempSync(join(tmpdir(), 'product-scope-test-'))
    vi.stubEnv('PANEDESK_HOME', home)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    host.manager.mockReturnValue(available)
    host.launch.mockImplementation((_spec, _env, _argv, options) => {
      if (options.productGroups !== undefined) {
        host.releases.push(options.productGroups.prepare({ directory: '/scope-fixture',
          requestPath: '/scope-fixture/request.json', startupErrorPath: '/scope-fixture/error.json' }, 'product-test.scope'))
      }
      return { stdin: null, stdout: null, stderr: null,
        direct: Promise.resolve({ exitCode: 0, signal: null }),
        owner: { signal: () => {}, waitForExit: async () => {}, terminateForHostExit: () => {} } }
    })
    try {
      await ctx.plugin(LocalSubprocessRuntime)
      const runtime = ctx.subprocess as LocalSubprocessRuntime
      runtime.internals = { platform: 'linux' }
      const groups = LinuxProductGroups.forHost(ctx)
      expect(groups).toBeDefined()
      if (groups === undefined) throw new Error('Attribution probe must succeed')
      expect(host.probe).toHaveReturnedWith(true)
      expect(groups['groups'].size).toBe(0)
      await runtime.spawn(command()).done
      expect(host.native).toHaveReturnedWith([])
      for (let index = 0; index < 2; index++) {
        const handle = runtime.spawn(command(true))
        expect((await handle.done).exitCode).toBe(0)
        await handle.waitForExit()
        if (!available) expect(handle.collected.stdout?.readFrom(0).text).toBe('started')
      }
      expect(host.manager).toHaveBeenCalledTimes(2)
      if (available) {
        expect(host.launch.mock.calls.slice(1).map(call => call[3].productGroups)).toEqual([groups, groups])
        await expect.poll(() => [...groups['groups']]).toEqual([[group, 10n]])
        expect(warn.mock.calls.filter(([message]) => message === LINUX_SOURCE_LIMITATION)).toEqual([])
      } else {
        expect([...groups['groups']]).toEqual([])
        expect(host.launch).toHaveBeenCalledOnce()
        expect(warn.mock.calls.filter(([message]) => message === LINUX_SOURCE_LIMITATION)).toEqual([[LINUX_SOURCE_LIMITATION]])
        expect(LINUX_SOURCE_LIMITATION).toContain('Known limitation:')
        expect(LINUX_SOURCE_LIMITATION).toContain('已知限制：')
      }
    } finally {
      await ctx.fiber.dispose()
      platform.mockRestore()
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
