/** SSH doubles inspect arguments and lifecycle without executing external commands. */
import { expect, test, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@panedesk/dsh-subprocess'
import { SshTunnel } from '../src/tunnel.ts'
import type { NodeLinkRuntimeConfig } from '../src/index.ts'
import { listenLoopback } from '@panedesk/dsh-host-admin'
import { randomBytes } from 'node:crypto'

test('uses independent bidirectional loopback forwards, strict host checks and owned child cleanup', async () => {
  const limits = { maxFrameBytes: 4096, requestTimeoutMs: 1000, maxPending: 2 }
  const listener = await listenLoopback(0, limits, () => ({ credential: randomBytes(32).toString('hex'), epoch: 'test' }), async () => ({}))
  const done = Promise.withResolvers<SubprocessOutcome>()
  const terminate = vi.fn(() => { done.resolve({ exitCode: 0, signal: null }) })
  const handle: SubprocessHandle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {}, done: done.promise, terminate, waitForExit: async () => { await done.promise; return true } }
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => handle)
  const disconnected = vi.fn()
  const options: NodeLinkRuntimeConfig = { ...limits, nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', directory: 'unused',
    listenPort: 0, peerPort: listener.port, maxStoreBytes: 4096, maxOperations: 10, staleMs: 1000,
    ssh: { alias: 'test-peer', cwd: process.cwd(), remotePort: listener.port, remoteTargetPort: listener.port,
      graceMs: 100, keepAliveSeconds: 5, keepAliveCount: 2, retryMs: 10, maxRetries: 0 } }
  const tunnel = new SshTunnel({ resolveExecutable: async () => '/usr/bin/ssh', spawn }, options, listener.port, disconnected)
  try {
    await tunnel.start()
    expect(tunnel.available).toBe(true)
    const spec = spawn.mock.calls[0]![0]
    expect(spec.argv).toContain('StrictHostKeyChecking=yes')
    expect(spec.argv).toContain('ForwardAgent=no')
    expect(spec.argv).toContain('-L'); expect(spec.argv).toContain('-R')
    expect(spec.argv.at(-1)).toBe('test-peer')
    expect(spec.env).toBeUndefined()
    terminate()
    await expect.poll(() => tunnel.available, { timeout: 10000 }).toBe(false)
    expect(disconnected).toHaveBeenCalledOnce()
  } finally { await tunnel.close(); await listener.close() }
})
