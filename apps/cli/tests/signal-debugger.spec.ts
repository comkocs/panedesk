/** CLI re-execution preserves invocation state while disabling signal-triggered debugging. */
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

  it('refuses to start without process replacement support', () => {
    expect(() => {
      disableSignalDebugger({ platform: 'linux', execArgv: [], execPath: 'node', argv: ['node', 'bin.js'], env: {} })
    }).toThrow('Start Node with --disable-sigusr1')
  })
})
