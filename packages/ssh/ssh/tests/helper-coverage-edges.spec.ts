import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@panedesk/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import type { SshStreamEndpoint } from '../src/schemas.ts'
import { authenticateStream } from '../src/stream-security.ts'
import { SshRpcPeer } from '../src/protocol.ts'

it('joins unauthenticated stream sockets before removing their reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-pending-edges-'))
  const ctx = new Context()
  const owner = new RemoteProcesses(ctx, root, 1, 5000)
  const sockets: Socket[] = []
  try {
    const prepared = await owner.prepare({ argv: ['target'], cwd: root, graceMs: 20, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    for (const endpoint of Object.values(prepared.streams)) {
      const socket = createConnection(endpoint.path)
      sockets.push(socket)
      socket.on('error', () => {})
      await once(socket, 'connect')
    }
    const closed = sockets.map(socket => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) }))
    await owner.close()
    await Promise.all(closed)
    expect(sockets.map(socket => socket.destroyed)).toEqual([true, true])
    expect(await readdir(root)).toEqual([])
  } finally {
    for (const socket of sockets) socket.destroy()
    try { await owner.close() } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }
})

it('stops rejected live snapshot forwarding and retains the exact collected output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-snapshot-edges-'))
  const ctx = new Context()
  ctx.provide('fs', { resolve: async () => ({ targetKey: root, displayPath: root }), processPath: () => root } as never)
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outcome = { exitCode: 0, signal: null }
  const finish = (): void => { stdout.end(); stderr.end(); completion.resolve(outcome) }
  const handle: SubprocessHandle = {
    stdin: new PassThrough(), stdout, stderr, control: undefined, collected: {}, done: completion.promise,
    terminate: finish, waitForExit: async () => { await completion.promise; return true },
  }
  ctx.provide('subprocess', { spawn: () => handle } as never)
  const owner = new RemoteProcesses(ctx, root, 1, 5000)
  const sockets = new Set<Socket>()
  const connect = async (endpoint: SshStreamEndpoint): Promise<Socket> => {
    const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
    sockets.add(raw); raw.on('error', () => {})
    await once(raw, 'connect')
    const socket = await authenticateStream(raw, endpoint.capability, 5000)
    sockets.add(socket); socket.on('error', () => {})
    return socket
  }
  const failed = vi.spyOn(SshRpcPeer.prototype, 'request').mockRejectedValue(new Error('Snapshot transport failed'))
  try {
    const prepared = await owner.prepare({ argv: ['target'], cwd: root, graceMs: 20, stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: 'pipe' } })
    const channels = Object.fromEntries(await Promise.all(
      Object.entries(prepared.streams).map(async ([name, endpoint]) => [name, await connect(endpoint)]),
    )) as Record<string, Socket>
    const errorChannel = channels.stderr
    if (errorChannel === undefined) throw new Error('Missing error channel')
    errorChannel.end(); errorChannel.resume()
    await owner.start(prepared.id)
    stdout.write('kept')
    finish()
    expect(await owner.done(prepared.id)).toEqual({ outcome, spills: {}, collected: { stdout: { totalBytes: 4, tail: Buffer.from('kept').toString('base64') } } })
    expect(failed).toHaveBeenCalledOnce()
    await vi.waitFor(async () => { expect(await readdir(root)).toEqual([]) })
  } finally {
    failed.mockRestore()
    for (const socket of [...sockets].reverse()) socket.destroy()
    try { await owner.close() } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }
})
