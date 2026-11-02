/** Fail closed on network APIs before the CLI or its providers can open a connection. */
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import dgram from 'node:dgram'
import dns from 'node:dns'

const file = process.env.SLIM_SMOKE_NETWORK_LOG
if (!file) throw new Error('slim smoke needs a network evidence file')
const attempts = []
writeFileSync(file, JSON.stringify({ attempts }))

function reject(operation) {
  attempts.push(operation)
  writeFileSync(file, JSON.stringify({ attempts }))
  throw new Error(`slim smoke forbids network access: ${operation}`)
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // Source launchers use local IPC; only filesystem sockets stay available.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof options === 'object' && options !== null && typeof options.path === 'string') {
    return Reflect.apply(connect, this, args)
  }
  if (typeof options === 'string' && options.includes('/')) return Reflect.apply(connect, this, args)
  return reject('socket.connect')
}
dgram.createSocket = () => reject('udp.createSocket')
dns.lookup = () => reject('dns.lookup')
dns.resolve = () => reject('dns.resolve')
dns.promises.lookup = () => reject('dns.lookup')
dns.promises.resolve = () => reject('dns.resolve')
globalThis.fetch = () => reject('fetch')
globalThis.WebSocket = class {
  constructor() { reject('websocket') }
}
syncBuiltinESMExports()
