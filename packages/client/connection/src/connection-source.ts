/** Physical-connection owner admission; credentials do not identify sandbox processes. */
import { Context, Service } from '@panedesk/cordis'
import { authLocale } from './auth-locale.ts'
import type { ConnectionSourceSocket, ConnectionTrustRequest } from './rpc.ts'

/** Registered product sandboxes and unknown sources deny otherwise authenticated owners. */
export type ConnectionSource = 'product-sandbox' | 'non-product' | 'unknown'

/** Host-owned synchronous platform lookup; failures must not grant owner access. */
export type ConnectionSourceLookup = (socket: ConnectionSourceSocket | undefined) => ConnectionSource

declare module '@panedesk/cordis' {
  interface Context {
    /** Host-owned platform classifiers; never populated by request data. */
    connectionSources: ConnectionSourceRegistry
  }
}

/** Instance-owned platform registration, shared by all owner admission paths. */
export class ConnectionSourceRegistry extends Service {
  private readonly providers = new Map<NodeJS.Platform, ConnectionSourceLookup>()
  private readonly withdrawn = new Set<NodeJS.Platform>()

  constructor(ctx: Context) {
    super(ctx, 'connectionSources')
  }

  /**
   * Register before the provider permits untrusted execution; removal fails closed for new connections.
   * @param platform - Operating system whose product markers the provider owns.
   * @param lookup - Synchronous bounded lookup; exceptions become unknown at admission.
   * @returns Owning-fiber disposer; existing socket decisions remain fixed until close.
   */
  register(platform: NodeJS.Platform, lookup: ConnectionSourceLookup): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.providers.has(platform)) throw new Error(`connection source already registered for ${platform}`)
      this.providers.set(platform, lookup)
      this.withdrawn.delete(platform)
      return () => {
        this.providers.delete(platform)
        this.withdrawn.add(platform)
      }
    }, `connection source: ${platform}`)
  }

  /**
   * Select the host platform, without interpreting browser sandbox flags as product identity.
   * @param socket - Accepted transport facts, or undefined for an in-process carrier.
   * @returns Registered decision; unimplemented platforms permit, withdrawn providers refuse.
   */
  classify(socket: ConnectionSourceSocket | undefined): ConnectionSource {
    const lookup = this.providers.get(process.platform)
    if (lookup !== undefined) return lookup(socket)
    return this.withdrawn.has(process.platform) ? 'unknown' : 'non-product'
  }
}

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
