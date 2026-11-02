/** SSH effects returning to this host retain current executable-input exclusions. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshConnection } from '../src/index.ts'
import { SshRpcPeer } from '../src/protocol.ts'
import type {} from '@panedesk/dsh-app-boot'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), networkInterfaces: () => ({
  test: [{ address: '192.0.2.17', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.0.2.17/24' }],
}) }))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill(): boolean { queueMicrotask(() => { this.emit('close', 0, null) }); return true }
}

for (const target of [
  { name: 'loopback alias', host: 'loopback-alias', address: '127.23.45.67', local: true },
  { name: 'interface alias', host: 'interface-alias', address: '192.0.2.17', local: true },
  { name: 'direct interface', host: '192.0.2.17', address: '192.0.2.17', local: true },
  { name: 'mapped loopback', host: 'mapped-alias', address: '::ffff:7f17:2d43', local: true },
  { name: 'mapped interface', host: 'mapped-interface', address: '::ffff:c000:211', local: true },
  { name: 'IPv6 loopback', host: 'ipv6-alias', address: '::1', local: true },
  { name: 'direct IPv6 loopback', host: '::1', address: '::1', local: true },
  { name: 'remote control', host: 'remote-alias', address: '192.0.2.18', local: false },
]) {
  it(`preserves host protection only for the resolved ${target.name}`, async () => {
    const ctx = new Context()
    const child = new Child()
    const calls: unknown[] = []
    const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method, params) => {
      if (method === 'hello') return {
        protocol: 2, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: process.version,
        kind: 'node-script', executable: '/node', root: '/remote/helper', workspace: '/project', serverAddress: target.address,
      }
      if (method === 'fs.write' || method === 'sandbox') { calls.push(params); return null }
      return null
    })
    transport.spawn.mockReturnValue(child)
    const service = new SshConnection(ctx, {
      host: target.host, launch: { kind: 'node-script', node: '/node' }, helper: '/helper', helperHash: 'a'.repeat(64),
      workspace: '/project', requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
    })
    onTestFinished(async () => { await service.dispose(); helper.close(); await ctx.fiber.dispose(); vi.restoreAllMocks() })
    await service.ready
    const policy = { mode: 'workspace-write', workspaceRoot: '/project', protectedPaths: ['/host/config.yml'], requiresWorkspaceAuthorization: true }
    await service.request('sandbox', { argv: ['true'], policy }, z.null())
    expect(calls).toEqual([{ argv: ['true'], policy: {
      mode: 'workspace-write', workspaceRoot: '/project', ...target.local ? { protectedPaths: ['/host/config.yml'] } : {},
    } }])
  })
}
