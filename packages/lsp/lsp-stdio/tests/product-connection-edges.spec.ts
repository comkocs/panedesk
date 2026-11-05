import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@panedesk/dsh-subprocess'
import { LspConnection } from '../src/connection.ts'

it('forwards a confined server identity through the connection spawner', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const handle: SubprocessHandle = {
    stdin: input, stdout: output, stderr: undefined, control: undefined, collected: {}, done: done.promise,
    terminate: () => { done.resolve({ exitCode: 0, signal: null }) }, waitForExit: async () => true,
  }
  const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => handle)
  const connection = new LspConnection({
    command: '/synthetic-server', args: ['literal'], cwd: '/workspace', env: {}, productSandbox: true,
    maxMessageBytes: 1024, maxStderrBytes: 1024, killGraceMs: 20, configuration: {},
  }, spawn, async () => null)
  try {
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      argv: ['/synthetic-server', 'literal'], cwd: '/workspace', env: {}, productSandbox: true,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1024 } }, graceMs: 20,
    })
  } finally {
    connection.terminate()
    await connection.closed
    input.destroy(); output.destroy()
  }
})
