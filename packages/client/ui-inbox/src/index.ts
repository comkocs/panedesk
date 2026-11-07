/** Owner-only inbox observation over the existing message queries; no mutation methods. */
import type { Context } from '@panedesk/cordis'
import type Schema from '@panedesk/schemastery'
import { setTimeout as delay } from 'node:timers/promises'
import { Remote, RemoteError, TypertRemoteService, observationConfig } from '@panedesk/dsh-typert-protocol'
import type { SessionId } from '@panedesk/dsh-session'
import type { MessageCursor, MessageQuarantineEvent } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-seat'
import type { InboxItem, InboxView } from './types.ts'

/** Availability and bounded read cadence for the inbox adapter. */
export interface Config {
  /** Enable owner-authorized inbox observations in an explicitly composed product. */
  enabled: boolean
  /** Host observation interval in milliseconds. */
  pollIntervalMs: number
  /** Maximum rows requested from each existing provider page. */
  pageSize: number
}
declare module '@panedesk/cordis' {
  interface Context {
    inbox: Inbox
    messageDeliveryUnavailable: { code: 'home-permissions'; path: string }
  }
}
/** Authenticated owners retain their existing local read authority. */
export default class Inbox extends TypertRemoteService {
  static Config: Schema<Config> = observationConfig
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'inbox')
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('inbox/unauthorized', 'Authenticated owner required', {})
    }
    if (this.lifetime.signal.aborted || this.ctx.invocation.signal.aborted) {
      throw new RemoteError('inbox/unavailable', 'Inbox observation unavailable', {})
    }
  }

  private async read(sessionId: SessionId): Promise<InboxView> {
    const delivery = this.ctx.get('messageDelivery')
    if (!delivery?.quarantined) {
      const reason = this.ctx.get('messageDeliveryUnavailable')
      throw new RemoteError('inbox/unavailable', 'Inbox queries unavailable', reason ? { reason } : {})
    }
    const items: InboxItem[] = [], quarantined: MessageQuarantineEvent[] = []
    let complete = true, cursor: MessageCursor | undefined
    const seats = this.ctx.get('seats'), engine = this.ctx.get('seatEngine')
    const authorized = seats && engine ? seats.withAuthority({ principalId: 'owner' as import('@panedesk/dsh-seat').SeatPrincipalId,
      origin: 'manual', nodeId: (await engine.nodeStatus()).nodeId }) : undefined
    do {
      this.owner()
      const page = await delivery.list({ targetSessionId: sessionId, includeMetadata: true, pagination: true,
        limit: this.config.pageSize, ...(cursor ? { cursor } : {}) })
      for (const status of page.items) {
        const sender = status.metadata?.senderSessionId
        const binding = sender && authorized ? await authorized.binding({ sessionId: sender }) : undefined
        items.push({ status, ...(binding && 'seat' in binding ? { senderSeat: binding.seat } : {}) })
      }
      if (page.complete) break
      if (!page.nextCursor || page.nextCursor === cursor) { complete = false; break }
      cursor = page.nextCursor
    } while (!this.lifetime.signal.aborted)
    cursor = undefined
    do {
      this.owner()
      const page = await delivery.quarantined({ targetSessionId: sessionId, limit: this.config.pageSize,
        ...(cursor ? { cursor } : {}) })
      quarantined.push(...page.items)
      complete &&= page.complete
      if (!page.nextCursor) break
      if (page.nextCursor === cursor) { complete = false; break }
      cursor = page.nextCursor
    } while (!this.lifetime.signal.aborted)
    this.owner()
    items.sort((a, b) => (a.status.metadata?.createdAt ?? 0) - (b.status.metadata?.createdAt ?? 0)
      || a.status.messageId.localeCompare(b.status.messageId))
    return { enabled: true, items, quarantined, complete }
  }

  /** Observe only received metadata and isolation evidence for the exact on-screen Session.
   * @param sessionId - Exact receiving Session, never a sender identity or wildcard.
   * @param signal - Remote stream lifetime.
   * @returns Ordered read-only inbox observations with explicit completeness.
   */
  @Remote({ mode: 'stream' })
  async *watch(sessionId: SessionId, signal: AbortSignal): AsyncIterable<InboxView> {
    this.owner()
    if (!sessionId.trim()) throw new RemoteError('inbox/invalid-session', 'Receiving Session required', {})
    if (!this.config.enabled) { yield { enabled: false, items: [], quarantined: [], complete: true }; return }
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    while (!combined.aborted) {
      yield await this.read(sessionId)
      try { await delay(this.config.pollIntervalMs, undefined, { signal: combined }) }
      catch (error) { if (error instanceof Error && error.name === 'AbortError') return; throw error }
    }
  }
}
