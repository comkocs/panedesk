/** Owner-only manual seat UI adapter; all window configuration remains in SeatService. */
import type { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type { SeatCallContext, SeatService } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import type { SeatOverview, SeatUiOpenRequest, SeatUiOpenResult } from './types.ts'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'seat-ui/unauthorized': Record<string, never> }
}

/** Host service for the generated seatUi namespace. */
export default class SeatUi extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'seatUi', { namespace: 'seatUi' }) }

  private async service(): Promise<SeatService | undefined> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('seat-ui/unauthorized', 'Seat UI requires the authenticated owner.', {})
    }
    const seats = this.ctx.get('seats')
    const engine = this.ctx.get('seatEngine')
    if (!seats || !engine) return undefined
    const node = await engine.nodeStatus()
    return seats.withAuthority({ principalId: 'owner' as SeatCallContext['principalId'], origin: 'manual', nodeId: node.nodeId })
  }

  /** Read the complete local catalog and existing-window status without starting a runtime.
   * @param sessionId - Optional occurrence whose exact binding is read instead of inferred from the window list.
   * @param signal - Caller cancellation when the resource or plugin is released.
   * @returns Authorized seat definitions and their current windows, or explicit unavailability.
   */
  @Remote
  async overview(sessionId?: SessionId, signal?: AbortSignal): Promise<SeatOverview> {
    signal?.throwIfAborted()
    const service = await this.service()
    if (!service) return { available: false, definitions: [], windows: [], complete: true }
    const readIdentity = async (): Promise<Pick<SeatOverview, 'binding' | 'identityStatus'>> => {
      if (sessionId === undefined) return {}
      try { return { binding: await service.binding({ sessionId }) } }
      catch (_error) {
        signal?.throwIfAborted()
        // Identity failures must not prevent independent catalog and online reads.
        return { identityStatus: 'failed' }
      }
    }
    const readCatalog = async (): Promise<Omit<SeatOverview, 'binding' | 'identityStatus'>> => {
      const definitions: SeatOverview['definitions'][number][] = []
      try {
        let cursor: string | undefined
        for (;;) {
          signal?.throwIfAborted()
          const page = await service.definitions(cursor === undefined ? {} : { cursor })
          definitions.push(...page.definitions)
          if (page.complete) break
          if (page.nextCursor === undefined || page.nextCursor === cursor) {
            return { available: true, definitions, windows: [], complete: false }
          }
          cursor = page.nextCursor
        }
        signal?.throwIfAborted()
        const listed = await service.list({})
        return { available: true, definitions, windows: listed.status === 'listed' ? listed.sessions : [],
          complete: listed.status === 'listed' && listed.complete }
      } catch (_error) {
        signal?.throwIfAborted()
        // Catalog or online failures do not erase independently verified identity.
        return { available: true, definitions, windows: [], complete: false }
      }
    }
    const [identity, catalog] = await Promise.all([readIdentity(), readCatalog()])
    const node = await this.ctx.get('seatEngine')?.nodeStatus()
    const diagnostics = node?.failure || node?.openingFailures?.length
      ? { ...(node.failure ? { engine: node.failure } : {}), openings: node.openingFailures ?? [] } : undefined
    return { ...catalog, ...identity, ...(diagnostics ? { diagnostics } : {}) }
  }

  /** Open with the existing manual provider, never sending the opening sentence.
   * @param request - Explicit seat, revision and stable operation identity.
   * @returns Provider result with a draft for user confirmation.
   */
  @Remote
  async open(request: SeatUiOpenRequest): Promise<SeatUiOpenResult> {
    const service = await this.service()
    if (!service) return { status: 'rejected', error: { code: 'unavailable', message: 'Seat providers are unavailable.',
      alternative: 'Enable the local seat providers before opening this seat.', retryable: true, effectState: 'none' } }
    return service.open({ ...request, origin: 'manual', openingMode: 'prefill' })
  }
}
