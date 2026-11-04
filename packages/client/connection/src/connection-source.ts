/** Physical-connection owner admission; credentials do not identify sandbox processes. */
import { authLocale } from './auth-locale.ts'
import type { ConnectionSourceSocket, ConnectionTrustRequest } from './rpc.ts'

/** Registered product sandboxes and unknown sources deny otherwise authenticated owners. */
export type ConnectionSource = 'product-sandbox' | 'non-product' | 'unknown'

/** Host-owned synchronous platform lookup; failures must not grant owner access. */
export type ConnectionSourceLookup = (socket: ConnectionSourceSocket | undefined) => ConnectionSource

/** One authentication owner's socket cache, shared by HTTP and WebSocket upgrades. */
export class OwnerConnectionSource {
  private readonly cache = new WeakMap<ConnectionSourceSocket, ConnectionSource>()

  /** @param lookup - Host platform adapter, not owner-configurable request input. */
  constructor(private readonly lookup: ConnectionSourceLookup) {}

  /**
   * Reject a sandbox or unverifiable connection before granting owner authority.
   * @param request - Accepted transport request; absent transport facts are passed to the platform adapter.
   * @returns Bilingual refusal, or undefined for a non-product connection.
   */
  rejection(request: ConnectionTrustRequest): string | undefined {
    const socket = request.socket
    let source = socket === undefined ? undefined : this.cache.get(socket)
    if (source === undefined) {
      try { source = socket?.destroyed === true ? 'unknown' : this.lookup(socket) }
      catch (_error) { source = 'unknown' }
      if (socket !== undefined) {
        this.cache.set(socket, source)
        socket.once?.('close', () => { this.cache.delete(socket) })
      }
    }
    if (source === 'non-product') return undefined
    const key = source === 'product-sandbox' ? 'sandboxSource' : 'unknownSource'
    return `${authLocale.en[key]} / ${authLocale.zh[key]}`
  }
}
