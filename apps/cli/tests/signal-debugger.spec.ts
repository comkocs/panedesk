/** CLI re-execution preserves invocation state while disabling signal-triggered debugging. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import { disableSignalDebugger } from '../src/signal-debugger.ts'

describe('CLI signal debugger bootstrap', () => {
  it.each(['linux', 'darwin'] as const)('re-executes %s with loaders, Inspector configuration, arguments and environment intact', (platform) => {
    const replaced = new Error('process replaced')
    const execve = vi.fn((): never => { throw replaced })
    const env = { PATH: '/usr/bin', PANEDESK_HOME: '/fixture/home' }
    const runtime = {
      platform, execPath: '/usr/bin/node', execArgv: ['--import', 'tsx/esm', '--inspect-port=0'],
      argv: ['/usr/bin/node', '/fixture/bin.js', '--profile', 'sdk', 'with spaces'], env, execve,
    }
    expect(() => { disableSignalDebugger(runtime) }).toThrow(replaced)
    expect(execve).toHaveBeenCalledExactlyOnceWith('/usr/bin/node', [
      '/usr/bin/node', '--import', 'tsx/esm', '--inspect-port=0', '--disable-sigusr1',
      '/fixture/bin.js', '--profile', 'sdk', 'with spaces',
    ], env)
  })

  it.each([
    { platform: 'win32' as const, execArgv: [] },
    { platform: 'linux' as const, execArgv: ['--disable-sigusr1'] },
  ])('does not replace an already protected or Windows invocation: $platform', ({ platform, execArgv }) => {
    const execve = vi.fn((): never => { throw new Error('unexpected replacement') })
    disableSignalDebugger({ platform, execArgv, execPath: 'node', argv: ['node', 'bin.js'], env: {}, execve })
    expect(execve).not.toHaveBeenCalled()
  })

  it.each(['linux', 'darwin'] as const)('rejects an unprotected %s IPC launcher without replacing its process', (platform) => {
    const execve = vi.fn((): never => { throw new Error('unexpected replacement') })
    const send = vi.fn()
    expect(() => {
      disableSignalDebugger({ platform, execArgv: [], execPath: 'node', argv: ['node', 'bin.js'], env: {}, execve, send })
    }).toThrow('CLI startup with an IPC channel requires Node --disable-sigusr1; process replacement would lose the channel. / 使用 IPC 通道启动 CLI 必须为 Node 指定 --disable-sigusr1；进程替换会丢失该通道。')
    expect(execve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an unprotected POSIX IPC entry before profile initialization and leaves Windows unchanged', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--help'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { NODE_OPTIONS: '' },
      ipc: true,
      reject: false,
    })
    if (process.platform === 'win32') {
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage: panedesk')
      expect(result.stderr).toBe('')
      return
    }
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('CLI startup with an IPC channel requires Node --disable-sigusr1; process replacement would lose the channel.')
    expect(result.stderr).toContain('使用 IPC 通道启动 CLI 必须为 Node 指定 --disable-sigusr1；进程替换会丢失该通道。')
  })

  it('preserves a protected IPC profile channel and keeps signal debugging disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-signal-ipc-'))
    try {
      const profile = join(root, 'profiles', 'signal-test')
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'signal-test-profile', private: true, dsh: { profile: { bundles: [] } },
      }))
      await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
        id: 'signal-host', name: new URL('./fixtures/signal-host.mjs', import.meta.url).href,
      }] }]))
      const flags = process.platform === 'win32' ? [] : ['--disable-sigusr1']
      const child = execa(process.execPath, [
        ...flags, '--inspect-port=0', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'signal-test',
      ], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { NODE_OPTIONS: '', PANEDESK_HOME: root, PANEDESK_TELEMETRY_DISABLED: '1' },
        ipc: true, reject: false,
      })
      try {
        expect(await child.getOneMessage()).toEqual({
          ready: true, pid: child.pid, args: [...flags, '--inspect-port=0', '--import', 'tsx/esm'],
        })
        if (process.platform !== 'win32') expect(child.kill('SIGUSR1')).toBe(true)
        await child.sendMessage('inspect')
        expect(await child.getOneMessage()).toEqual({
          message: 'inspect', inspector: false, args: [...flags, '--inspect-port=0', '--import', 'tsx/esm'],
        })
      } finally {
        child.kill('SIGTERM')
        const result = await child
        expect(result.stderr).not.toContain('Debugger listening')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to start without process replacement support', () => {
    expect(() => {
      disableSignalDebugger({ platform: 'linux', execArgv: [], execPath: 'node', argv: ['node', 'bin.js'], env: {} })
    }).toThrow('Start Node with --disable-sigusr1')
  })
})
