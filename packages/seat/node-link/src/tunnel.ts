/** One supervised OpenSSH process owns two explicitly loopback-bound forwards. */
import type { SubprocessHandle, SubprocessRuntime } from '@panedesk/dsh-subprocess'
import type { NodeLinkRuntimeConfig } from './index.ts'

function reasonCategory(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError'
  if (error instanceof RangeError) return 'RangeError'
  return error instanceof Error ? 'Error' : 'unknown'
}

function stderrSummary(tail: Buffer): string {
  const safe = tail.toString('utf8')
    .replace(/(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?:%[\w.-]+)?/gi, '<addr>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<addr>')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
  return safe.replace(/\n$/, '').split('\n').slice(-5).map((line) => {
    let bounded = '', bytes = 0
    for (const character of line) {
      bytes += Buffer.byteLength(character)
      if (bytes > 200) break
      bounded += character
    }
    return bounded
  }).join('\n')
}

/** Supervision never executes remote commands or copies identity configuration. */
export class SshTunnel {
  private child: SubprocessHandle | undefined
  private lifetime = new AbortController()
  private supervision: Promise<void> | undefined
  private live = false
  private stderrTail: Buffer = Buffer.alloc(0)
  private generation = 0
  private startedAt = 0
  private exhaustion: string | undefined
  constructor(private readonly runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
    private readonly options: NodeLinkRuntimeConfig, private readonly localPort: number,
    private readonly disconnected: () => void,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}) {}
  /** A live process is only transport availability, not peer authentication. */
  get available(): boolean { return this.live }
  /** Local exhausted-state explanation for existing node status diagnostics. */
  get exhaustedReason(): string | undefined { return this.exhaustion }
  /** Start bounded supervision; no credential enters argv or environment.
   * A child surviving at least retryMs resets the retry budget before its next retry.
   * Faster exits consume the remaining maxRetries budget; every retry waits retryMs.
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
      this.stderrTail = Buffer.alloc(0)
      this.child.stdout?.resume()
      this.child.stderr?.on('data', (chunk: Buffer) => {
        // Copy only the retained bytes, including when a provider emits one oversized chunk.
        this.stderrTail = chunk.length >= 4096 ? Buffer.from(chunk.subarray(-4096))
          : Buffer.concat([this.stderrTail.subarray(Math.max(0, this.stderrTail.length + chunk.length - 4096)), chunk])
      })
      this.startedAt = performance.now()
      this.generation++
      this.live = true
      this.log('info', `ssh-tunnel started generation=${this.generation} pid=${this.child.processIdentity?.pid ?? 'unknown'}`)
    }
    spawn()
    this.supervision = (async () => {
      for (let attempt = 0; ; attempt++) {
        const child = this.child
        if (child === undefined) return
        let category: string | undefined
        const outcome = await child.done.catch((error: unknown) => { category = reasonCategory(error); return undefined })
        const aliveMs = Math.max(0, Math.floor(performance.now() - this.startedAt))
        const summary = stderrSummary(this.stderrTail)
        this.log('warn', `ssh-tunnel exited generation=${this.generation} exitCode=${outcome?.exitCode ?? 'unknown'} signal=${outcome?.signal ?? 'none'} aliveMs=${aliveMs}${category === undefined ? '' : ` category=${category}`} stderr=${JSON.stringify(summary)}`)
        this.live = false
        this.disconnected()
        if (this.lifetime.signal.aborted) return
        if (aliveMs >= ssh.retryMs) attempt = 0
        if (attempt >= ssh.maxRetries) {
          const firstSentence = summary.split('\n')[0]?.split(/(?<=[.!?])\s/)[0] ?? ''
          this.exhaustion = `SSH tunnel exhausted: exitCode=${outcome?.exitCode ?? 'unknown'} signal=${outcome?.signal ?? 'none'}${category === undefined ? '' : ` category=${category}`}${firstSentence ? `; ${firstSentence}` : ''} Link remains disconnected until host restart.`
          this.log('error', `ssh-tunnel exhausted generation=${this.generation}; link remains disconnected until host restart`)
          return
        }
        this.log('warn', `ssh-tunnel retry attempt=${attempt + 1} maxRetries=${ssh.maxRetries} waitMs=${ssh.retryMs}`)
        await new Promise<void>((resolve) => {
          const abort = (): void => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { this.lifetime.signal.removeEventListener('abort', abort); resolve() }, ssh.retryMs)
          this.lifetime.signal.addEventListener('abort', abort, { once: true })
        })
        this.lifetime.signal.throwIfAborted()
        spawn()
      }
    })().catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.log('error', `ssh-tunnel supervision-failed category=${reasonCategory(error)}`)
      this.live = false
      this.disconnected()
    })
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
