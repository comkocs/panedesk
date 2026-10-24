/** One supervised OpenSSH process owns two explicitly loopback-bound forwards. */
import type { SubprocessHandle, SubprocessRuntime } from '@panedesk/dsh-subprocess'
import type { NodeLinkRuntimeConfig } from './index.ts'

/** Supervision never executes remote commands or copies identity configuration. */
export class SshTunnel {
  private child: SubprocessHandle | undefined
  private lifetime = new AbortController()
  private supervision: Promise<void> | undefined
  private live = false
  constructor(private readonly runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
    private readonly options: NodeLinkRuntimeConfig, private readonly localPort: number,
    private readonly disconnected: () => void) {}
  /** A live process is only transport availability, not peer authentication. */
  get available(): boolean { return this.live }
  /** Start bounded supervision; no credential enters argv or environment.
   * @returns Completion once the first owned child exists.
   */
  async start(): Promise<void> {
    const ssh = this.options.ssh
    if (ssh === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(ssh.alias)) throw new Error('SSH alias rejected')
    const executable = await this.runtime.resolveExecutable('ssh', undefined, this.lifetime.signal)
    const spawn = (): void => {
      this.lifetime.signal.throwIfAborted()
      this.child = this.runtime.spawn({ argv: [executable, '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ForwardAgent=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
        '-o', `ServerAliveInterval=${ssh.keepAliveSeconds}`, '-o', `ServerAliveCountMax=${ssh.keepAliveCount}`,
        '-L', `127.0.0.1:${this.options.peerPort}:127.0.0.1:${ssh.remoteTargetPort}`,
        '-R', `127.0.0.1:${ssh.remotePort}:127.0.0.1:${this.localPort}`, ssh.alias], cwd: ssh.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: ssh.graceMs, signal: this.lifetime.signal })
      this.child.stdout?.resume(); this.child.stderr?.resume()
      this.live = true
    }
    spawn()
    this.supervision = (async () => {
      for (let attempt = 0; ; attempt++) {
        const child = this.child
        if (child === undefined) return
        await child.done.catch((error: unknown) => { void error })
        this.live = false
        this.disconnected()
        if (this.lifetime.signal.aborted || attempt >= ssh.maxRetries) return
        await new Promise<void>((resolve) => {
          const abort = (): void => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { this.lifetime.signal.removeEventListener('abort', abort); resolve() }, ssh.retryMs)
          this.lifetime.signal.addEventListener('abort', abort, { once: true })
        })
        this.lifetime.signal.throwIfAborted()
        spawn()
      }
    })().catch((error: unknown) => { void error; this.live = false; this.disconnected() })
  }
  /** Stop only the owned process range and await quiescence.
   * @returns Completion after supervision and child exit.
   */
  async close(): Promise<void> {
    this.lifetime.abort()
    this.child?.terminate()
    await this.supervision
    if (this.child !== undefined && !await this.child.waitForExit()) throw new Error('SSH cleanup incomplete')
    this.live = false
  }
}
