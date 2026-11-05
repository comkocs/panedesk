import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { launchLinuxScope, prepareLinuxTerminalScope, type LinuxScopeInternals } from '../src/linux-scope.ts'
import { LinuxProductGroups } from '../src/linux-product-groups.ts'

const probe = vi.hoisted(() => vi.fn(() => true))
vi.mock('@panedesk/node-addon-system/socket-cgroup', () => ({
  loadSocketCgroupQuery: () => ({ probe, query: () => 1n }),
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    accessSync: () => {},
    readFileSync: () => '0::/synthetic\n',
    mkdtempSync: (prefix: string) => {
      if (prefix.startsWith('/sys/fs/cgroup')) return '/sys/fs/cgroup/synthetic/probe'
      return fs.mkdtempSync(prefix)
    },
    rmdirSync: (path: string) => {
      if (!path.startsWith('/sys/fs/cgroup')) fs.rmdirSync(path)
    },
  }
})

it('reserves product ownership for a terminal before publishing its scope invocation', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const root = fs.mkdtempSync(join(tmpdir(), 'product-terminal-edges-'))
  onTestFinished(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
  const groups = LinuxProductGroups.probe()
  if (groups === undefined) throw new Error('Synthetic capability probe failed')
  const release = vi.fn()
  const prepare = vi.spyOn(groups, 'prepare').mockReturnValue(release)
  const temporary = vi.spyOn(await import('node:fs'), 'mkdtempSync').mockImplementation(fs.mkdtempSync)
  const launch = prepareLinuxTerminalScope({
    argv: ['/synthetic-target'], cwd: root, env: {}, cols: 80, rows: 24, terminalType: 'xterm', graceMs: 20, productSandbox: true,
  }, {}, [], { productGroups: groups, privateRoot: root, runnerInvocation: [process.execPath] })
  temporary.mockRestore()
  const files = prepare.mock.calls[0]?.[0]
  if (files === undefined) throw new Error('Missing private exchange')
  expect(files.directory.startsWith(root + '/')).toBe(true)
  expect(launch.args).toContain('--property=Delegate=yes')
  expect(prepare.mock.calls[0]?.[1]).toMatch(/^dsh-terminal-.*\.scope$/)
  launch.cleanup()
  expect(release).toHaveBeenCalledOnce()
  expect(existsSync(files.directory)).toBe(false)
})

it.each(['terminal', 'ordinary'] as const)('cleans a failed product registration before %s launch', async (kind) => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const root = fs.mkdtempSync(join(tmpdir(), 'product-scope-refusal-'))
  onTestFinished(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
  const groups = LinuxProductGroups.probe()
  if (groups === undefined) throw new Error('Synthetic capability probe failed')
  const failure = new Error('Registration refused')
  vi.spyOn(groups, 'prepare').mockImplementation(() => { throw failure })
  vi.spyOn(await import('node:fs'), 'mkdtempSync').mockImplementation(fs.mkdtempSync)
  const calls = vi.fn()
  const spawn: NonNullable<LinuxScopeInternals['spawn']> = () => {
    calls()
    throw new Error('Unexpected target launch')
  }
  const internals: LinuxScopeInternals = {
    productGroups: groups, privateRoot: root, runnerInvocation: [process.execPath], spawn,
  }
  if (kind === 'terminal') {
    expect(() => prepareLinuxTerminalScope({
      argv: ['/synthetic-target'], cwd: root, env: {}, cols: 80, rows: 24, terminalType: 'xterm', graceMs: 20, productSandbox: true,
    }, {}, [], internals)).toThrow(failure)
  } else {
    expect(() => launchLinuxScope({
      argv: ['/synthetic-target'], cwd: root, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 20, productSandbox: true,
    }, {}, [], internals)).toThrow(failure)
  }
  expect(calls).not.toHaveBeenCalled()
  expect(readdirSync(root)).toEqual([])
})
