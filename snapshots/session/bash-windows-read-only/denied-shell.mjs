/** Native-denial substitute; real policy, tools, jobs, and session persistence remain composed. */
import { ShellExecutor } from '@panedesk/dsh-shell'

export default class DeniedShell extends ShellExecutor {
  get sandboxMode() { return 'read-only' }

  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 1000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64000,
      sandboxPolicy: request.sandboxPolicy,
      signal: request.signal,
    }
  }

  async execute(spec) {
    if (spec.sandboxPolicy?.mode !== 'read-only') throw new Error('Expected read-only confinement')
    const sandbox = { mode: 'read-only', denied: true }
    const reader = { readFrom: fromByte => ({ text: '', nextOffset: fromByte, lossy: false }) }
    return {
      status: 'completed', exitCode: 1, signal: null, sandbox,
      done: Promise.resolve(), kill: () => false,
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: reader, stderr: reader },
      result: async () => ({
        exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox,
      }),
    }
  }
}
