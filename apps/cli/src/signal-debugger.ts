/** Disable signal-triggered Inspector startup before a CLI loads its profile or credentials. */

type Runtime = Pick<NodeJS.Process, 'platform' | 'execPath' | 'execArgv' | 'argv' | 'env' | 'execve'>

/**
 * Replace an unprotected POSIX CLI with the same invocation and signal debugging disabled.
 * Windows has no SIGUSR1. Explicit Inspector options remain available to trusted launchers.
 * @param runtime - Process to replace; injected by startup tests.
 * @throws When the runtime cannot replace the process; no profile is started in that case.
 */
export function disableSignalDebugger(runtime: Runtime = process): void {
  if (runtime.platform === 'win32' || runtime.execArgv.includes('--disable-sigusr1')) return
  if (runtime.execve === undefined) {
    throw new Error('This Node runtime cannot disable signal debugging before startup. Start Node with --disable-sigusr1. / 此 Node 运行时无法在启动前禁用信号调试，请使用 --disable-sigusr1 启动 Node。')
  }
  runtime.execve(runtime.execPath, [runtime.execPath, ...runtime.execArgv, '--disable-sigusr1', ...runtime.argv.slice(1)], runtime.env)
}
