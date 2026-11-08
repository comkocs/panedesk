/** An operation-owned SSH local forward; private keys are read in place, never copied. */
import { readFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { Client } from 'ssh2'
import { expandHomePath } from '@panedesk/dsh-home-paths'
import type { DatabaseConnection } from './types.ts'

/** Open one loopback-only forward. Closing it destroys every accepted socket and SSH channel. */
export async function openTunnel(config: DatabaseConnection, passphrase: string, signal: AbortSignal): Promise<{ port: number; close(): void }> {
  signal.throwIfAborted()
  const privateKey = await readFile(expandHomePath(config.ssh.privateKeyPath))
  signal.throwIfAborted()
  const ssh = new Client()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    ssh.forwardOut('127.0.0.1', socket.remotePort ?? 0, config.host, config.port, (error, channel) => {
      if (error) { socket.destroy(error); return }
      if (socket.destroyed) { channel.destroy(); return }
      channel.on('error', () => socket.destroy())
      channel.once('close', () => socket.destroy())
      socket.once('close', () => channel.destroy())
      socket.pipe(channel).pipe(socket)
    })
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    for (const socket of sockets) socket.destroy()
    server.close()
    ssh.destroy()
  }
  ssh.on('error', close)
  ssh.once('close', close)
  server.on('error', close)
  signal.addEventListener('abort', close, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      ssh.once('ready', resolve)
      ssh.once('error', reject)
      ssh.once('close', () => reject(new Error('SSH connection closed before it was ready')))
      ssh.connect({ host: config.ssh.host, port: config.ssh.port, username: config.ssh.user,
        privateKey, passphrase, readyTimeout: 15_000 })
    })
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('close', () => reject(new Error('SSH local forward closed before it was ready')))
      server.listen(0, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SSH local forward did not acquire a port')
    return { port: address.port, close }
  } catch (error) {
    close()
    throw error
  }
}
