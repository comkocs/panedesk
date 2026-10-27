/** SSH doubles inspect arguments and lifecycle without executing external commands. */
import { afterEach, expect, test, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@panedesk/dsh-subprocess'
import { SshTunnel } from '../src/tunnel.ts'
import type { NodeLinkRuntimeConfig } from '../src/index.ts'
import { listenLoopback } from '@panedesk/dsh-host-admin'
import { randomBytes } from 'node:crypto'

afterEach(() => { vi.useRealTimers() })

function supervised(maxRetries = 2) {
  vi.useFakeTimers()
  const children: { done: ReturnType<typeof Promise.withResolvers<SubprocessOutcome>>; stderr: PassThrough }[] = []
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => {
    const done = Promise.withResolvers<SubprocessOutcome>(), stderr = new PassThrough()
    children.push({ done, stderr })
    return { processIdentity: { pid: 100 + children.length }, stdin: undefined, stdout: undefined, stderr, control: undefined,
      collected: {}, done: done.promise, terminate: () => { done.resolve({ exitCode: 0, signal: null }) },
      waitForExit: async () => { await done.promise; return true } }
  })
  const options: NodeLinkRuntimeConfig = { nodeId: 'node-a', peerNodeId: 'node-b', peerName: 'peer', directory: 'unused',
    listenPort: 0, peerPort: 1, maxFrameBytes: 4096, requestTimeoutMs: 1000, maxPending: 2,
    maxStoreBytes: 4096, maxOperations: 10, staleMs: 1000,
    ssh: { alias: 'test-peer', cwd: process.cwd(), remotePort: 1, remoteTargetPort: 1,
      graceMs: 100, keepAliveSeconds: 5, keepAliveCount: 2, retryMs: 100, maxRetries } }
  const log = vi.fn<(level: 'info' | 'warn' | 'error', message: string) => void>()
  const tunnel = new SshTunnel({ resolveExecutable: async () => '/usr/bin/ssh', spawn }, options, 1, vi.fn(), log)
  const messages = (event: string) => log.mock.calls.filter(([, message]) => message.startsWith(`ssh-tunnel ${event} `))
  const exit = async (exitCode: number | null = 255, signal: NodeJS.Signals | null = null) => {
    children.at(-1)!.done.resolve({ exitCode, signal })
    await vi.advanceTimersByTimeAsync(0)
  }
  return { tunnel, spawn, children, log, messages, exit }
}

test('logs bounded address-redacted exit facts with generation, pid and lifetime', async () => {
  const fixture = supervised(0)
  try {
    await fixture.tunnel.start()
    fixture.children[0]!.stderr.write('old\n'.repeat(10) + 'peer 192.0.2.1 [2001:db8::1] ::ffff:192.0.2.2\n' + 'x'.repeat(500) + '\nlast failure\n')
    await vi.advanceTimersByTimeAsync(25)
    await fixture.exit()
    expect(fixture.messages('started')).toEqual([['info', 'ssh-tunnel started generation=1 pid=101']])
    const exits = fixture.messages('exited')
    expect(exits).toHaveLength(1)
    expect(exits[0]![0]).toBe('warn')
    expect(exits[0]![1]).toContain('generation=1 exitCode=255 signal=none aliveMs=25')
    const summary: unknown = JSON.parse(exits[0]![1].split(' stderr=')[1]!)
    if (typeof summary !== 'string') throw new Error('Missing stderr summary')
    expect(summary).toContain('peer <addr> [<addr>] <addr>')
    expect(summary).toContain('last failure')
    expect(summary).not.toMatch(/192\.0\.2|2001:db8/)
    expect(summary.split('\n').length).toBeLessThanOrEqual(5)
    expect(summary.split('\n').every(line => line.length <= 200)).toBe(true)
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1024)
  } finally { await fixture.tunnel.close() }
})

test('logs retry number and delay, then exhausts once without further spawns', async () => {
  const fixture = supervised(1)
  try {
    await fixture.tunnel.start()
    await fixture.exit()
    expect(fixture.messages('retry')).toEqual([['warn', 'ssh-tunnel retry attempt=1 maxRetries=1 waitMs=100']])
    await vi.advanceTimersByTimeAsync(99)
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await fixture.exit(null, 'SIGTERM')
    expect(fixture.messages('exited')[1]![1]).toContain('signal=SIGTERM')
    expect(fixture.messages('exhausted')).toHaveLength(1)
    expect(fixture.messages('exhausted')[0]).toEqual(['error', expect.stringContaining('link remains disconnected until host restart')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
  } finally { await fixture.tunnel.close() }
})

test('normal close and cancellation during retry never log exhaustion or supervision failure', async () => {
  for (const waiting of [false, true]) {
    const fixture = supervised()
    await fixture.tunnel.start()
    if (waiting) await fixture.exit()
    await fixture.tunnel.close()
    expect(fixture.messages('exhausted')).toEqual([])
    expect(fixture.messages('supervision-failed')).toEqual([])
  }
})

test('retains a bounded stderr buffer under sustained and oversized output', async () => {
  const fixture = supervised(0)
  try {
    await fixture.tunnel.start()
    const chunk = Buffer.from('failure detail\n'.repeat(100000))
    for (let index = 0; index < 20; index++) {
      fixture.children[0]!.stderr.write(chunk)
      const tail: unknown = Reflect.get(fixture.tunnel, 'stderrTail')
      expect(Buffer.isBuffer(tail)).toBe(true)
      if (!Buffer.isBuffer(tail)) throw new Error('Missing bounded stderr buffer')
      expect(tail.length).toBeLessThanOrEqual(4096)
    }
    await fixture.exit()
    const summary: unknown = JSON.parse(fixture.messages('exited')[0]![1].split(' stderr=')[1]!)
    if (typeof summary !== 'string') throw new Error('Missing stderr summary')
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1024)
  } finally { await fixture.tunnel.close() }
})

test('logs only a fixed reason category when retry supervision fails', async () => {
  const fixture = supervised()
  try {
    await fixture.tunnel.start()
    fixture.spawn.mockImplementationOnce(() => { throw new TypeError('sensitive failure detail') })
    await fixture.exit()
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.messages('supervision-failed')).toEqual([['error', 'ssh-tunnel supervision-failed category=TypeError']])
    expect(fixture.log.mock.calls.flat().join(' ')).not.toContain('sensitive')
  } finally { await fixture.tunnel.close() }
})

test('bounds consecutive fast failures to the retry budget with a full delay between spawns', async () => {
  const fixture = supervised(2)
  try {
    await fixture.tunnel.start()
    for (let generation = 1; generation <= 3; generation++) {
      expect(fixture.spawn).toHaveBeenCalledTimes(generation)
      await vi.advanceTimersByTimeAsync(99)
      await fixture.exit()
      expect(fixture.messages('exhausted')).toHaveLength(generation === 3 ? 1 : 0)
      await vi.advanceTimersByTimeAsync(99)
      expect(fixture.spawn).toHaveBeenCalledTimes(generation)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(fixture.spawn).toHaveBeenCalledTimes(3)
    expect(fixture.messages('retry').map(([, message]) => message)).toEqual([
      'ssh-tunnel retry attempt=1 maxRetries=2 waitMs=100', 'ssh-tunnel retry attempt=2 maxRetries=2 waitMs=100',
    ])
  } finally { await fixture.tunnel.close() }
})

test('resets the retry budget after each of five stable generations including the exact threshold', async () => {
  const fixture = supervised(2)
  try {
    await fixture.tunnel.start()
    for (let generation = 1; generation <= 5; generation++) {
      await vi.advanceTimersByTimeAsync(100)
      await fixture.exit()
      expect(fixture.messages('exhausted')).toHaveLength(0)
      expect(fixture.messages('retry').at(-1)?.[1]).toBe('ssh-tunnel retry attempt=1 maxRetries=2 waitMs=100')
      await vi.advanceTimersByTimeAsync(100)
      expect(fixture.spawn).toHaveBeenCalledTimes(generation + 1)
    }
  } finally { await fixture.tunnel.close() }
})

test('clears only stable generations in a fast stable fast fast fast sequence', async () => {
  const fixture = supervised(3)
  try {
    await fixture.tunnel.start()
    const expectedRetries = [1, 1, 2, 3, undefined]
    for (let index = 0; index < expectedRetries.length; index++) {
      await vi.advanceTimersByTimeAsync(index === 1 ? 100 : 99)
      await fixture.exit()
      const attempt = expectedRetries[index]
      expect(fixture.messages('exhausted')).toHaveLength(attempt === undefined ? 1 : 0)
      if (attempt !== undefined) expect(fixture.messages('retry').at(-1)?.[1])
        .toBe(`ssh-tunnel retry attempt=${attempt} maxRetries=3 waitMs=100`)
      await vi.advanceTimersByTimeAsync(100)
      expect(fixture.spawn).toHaveBeenCalledTimes(attempt === undefined ? 5 : index + 2)
    }
  } finally { await fixture.tunnel.close() }
})

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
