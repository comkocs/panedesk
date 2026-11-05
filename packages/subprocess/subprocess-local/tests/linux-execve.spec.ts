import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@panedesk/dsh-lazy-require')
  vi.resetModules()
})

describe.skipIf(process.platform !== 'linux')('Linux libc execve binding', () => {
  it.each([undefined, 'pipe'] as const)('preserves inherited stdio with control %s and reports execve errno', async (control) => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === 2) return 0
      return fd === 7 ? 1 : [1, 0, 5][fd]
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load, config: () => ({ sync_heap_size: 2 * 1024 * 1024 }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' }, control)
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [2, 1, 0],
      [2, 2, 4],
      ...control === 'pipe' ? [[7, 1, 0], [7, 2, 0]] : [],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("ENOENT: no such file or directory, execve '/missing/tool'")
  })

  it('rejects the first argument over the aligned heap budget before any native call', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn(() => 0)
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({
        errno: () => 2,
        config: () => ({ sync_heap_size: 2 * 1024 * 1024 }),
        load: () => ({ func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl }),
      }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const argv = Array.from({ length: 84_649 }, () => 'x')
    expect(() => loadLinuxExecve()('/bin/true', argv, {})).toThrow('ENOENT')
    expect(nativeExecve).toHaveBeenCalledOnce()
    nativeExecve.mockClear()
    nativeFcntl.mockClear()
    argv.push('x')
    expect(() => loadLinuxExecve()('/bin/true', argv, {})).toThrow('execve argument budget exceeded')
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(nativeFcntl).not.toHaveBeenCalled()
  })

  it('accepts a long single string while preserving the native execve result', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn(() => 0)
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({
        errno: () => 2,
        config: () => ({ sync_heap_size: 2 * 1024 * 1024, async_heap_size: 128 * 1024 }),
        load: () => ({ func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl }),
      }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const argument = 'x'.repeat(72_000)
    const value = 'y'.repeat(8193)
    expect(() => loadLinuxExecve()('/bin/true', [argument], { LONG: value })).toThrow('ENOENT')
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith('/bin/true', [argument, null], [`LONG=${value}`, null])
  })

  it('reads the synchronous heap size at each native invocation', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn(() => 0)
    const config = vi.fn(() => ({ sync_heap_size: 256 * 1024, async_heap_size: 128 * 1024 }))
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({
        errno: () => 2, config,
        load: () => ({ func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl }),
      }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    const argv = Array.from({ length: 5000 }, () => 'x')
    expect(() => execve('/bin/true', argv, {})).toThrow('ENOENT')
    expect(config).toHaveBeenCalledOnce()
    expect(nativeExecve).toHaveBeenCalledOnce()
    config.mockReturnValue({ sync_heap_size: 128 * 1024, async_heap_size: 256 * 1024 })
    nativeExecve.mockClear()
    nativeFcntl.mockClear()
    expect(() => execve('/bin/true', argv, {})).toThrow('execve argument budget exceeded')
    expect(config).toHaveBeenCalledTimes(2)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(nativeFcntl).not.toHaveBeenCalled()
  })

  it('reports failure to read descriptor flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn(() => -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }), config: () => ({ sync_heap_size: 2 * 1024 * 1024 }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenCalledExactlyOnceWith(0, 1, 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear close-on-exec before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('@panedesk/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }), config: () => ({ sync_heap_size: 2 * 1024 * 1024 }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })
})
