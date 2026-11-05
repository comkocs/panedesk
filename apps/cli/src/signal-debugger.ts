/** Disable signal-triggered Inspector startup before a CLI loads its profile or credentials. */

type Runtime = Pick<NodeJS.Process, 'platform' | 'execPath' | 'execArgv' | 'argv' | 'env' | 'execve' | 'send'>

/**
 * Replace an unprotected POSIX CLI with the same invocation and signal debugging disabled.
 * IPC launchers must supply --disable-sigusr1 themselves because process replacement loses their channel.
 * Windows has no SIGUSR1. Explicit Inspector options remain available to trusted launchers.
 * @param runtime - Process to replace; injected by startup tests.
 * @throws When an IPC launcher omits the flag or process replacement is unavailable; no profile is started.
 */
export function disableSignalDebugger(runtime: Runtime = process): void {
  if (runtime.platform === 'win32' || runtime.execArgv.includes('--disable-sigusr1')) return
  if (runtime.send !== undefined) {
    throw new Error('CLI startup with an IPC channel requires Node --disable-sigusr1; process replacement would lose the channel. / 使用 IPC 通道启动 CLI 必须为 Node 指定 --disable-sigusr1；进程替换会丢失该通道。')
  }
  if (runtime.execve === undefined) {
    throw new Error('This Node runtime cannot disable signal debugging before startup. Start Node with --disable-sigusr1. / 此 Node 运行时无法在启动前禁用信号调试，请使用 --disable-sigusr1 启动 Node。')
  }
  runtime.execve(runtime.execPath, [runtime.execPath, ...runtime.execArgv, '--disable-sigusr1', ...runtime.argv.slice(1)], runtime.env)
}
