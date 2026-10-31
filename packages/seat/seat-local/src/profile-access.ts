/** Local owner capabilities for catalog editing and historical opening observations. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import type { SeatProfileSnapshot, RemoveSeatProfileRequest } from './types.ts'
export type { SeatProfileSnapshot, RemoveSeatProfileRequest } from './types.ts'
import type { SeatStore } from './store.ts'
import type { LocalSeatOptions } from './service-options.ts'
import { refuse, SeatLocalError } from './errors.ts'
import { parseDefinition } from './schema.ts'

/** Owner-only capabilities; every call checks live invocation authority. */
export interface SeatProfileAccess {
  read(): Promise<SeatProfileSnapshot>
  takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult>
  remove(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult>
  save(request: { definition: unknown; expectedRevision: number; operationId: T.SeatOperationId }): Promise<T.SeatCatalogMutationResult>
  preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>
  commit(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult>
}

declare module '@panedesk/cordis' {
  interface Context { seatProfilesLocal: SeatProfileAccess }
}

/** Install the smallest local editor capability without expanding the seat wire protocol.
 * @param ctx - Local provider lifecycle and invocation authority.
 * @param store - Catalog CAS owner.
 * @param service - Existing local seat operations.
 * @param options - Deployment-owned pagination and node identity.
 */
export function registerProfileAccess(ctx: Context, store: SeatStore, service: T.SeatService, options: LocalSeatOptions): void {
  let active = true
  ctx.effect(() => () => { active = false })
  const owner = (): T.SeatService => {
    if (!active || ctx.invocation?.peer.principal.kind !== 'owner' || ctx.invocation.signal.aborted) {
      refuse('unauthorized', 'Authenticated owner required.', 'Sign in as the local owner.')
    }
    return service.withAuthority({ principalId: 'owner' as T.SeatPrincipalId, origin: 'manual', nodeId: options.nodeId })
  }
  const read = async (): Promise<SeatProfileSnapshot> => {
    owner()
    const engine = ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine)) refuse('unavailable', 'Opening history is unavailable.', 'Restore the local seat engine.')
    await engine.ready()
    const windows: SeatProfileSnapshot['windows'] = [...engine.journal.projection.opens.values()].flatMap(open =>
      open.binding.kind === 'seat' && !engine.journal.projection.closed.has(open.sessionId)
        && !(open.phase === 'opening-failed' && open.failure?.effectState === 'none')
        ? [{ seat: open.binding.seat, sessionId: open.sessionId,
          title: open.title ?? open.binding.seat, nodeId: open.binding.nodeId }] : [])
    const pending: SeatProfileSnapshot['pending'][number][] = []
    let cursor: T.EngineCursor | undefined
    do {
      owner()
      const page = await engine.pending({ limit: options.pageSize, ...(cursor === undefined ? {} : { cursor }) })
      pending.push(...page.items.filter(item => item.reason === 'approval').map(({ queueItemId, seat, reason, stateVersion }) =>
        ({ queueItemId, seat, reason, stateVersion })))
      if (page.complete) break
      if (page.nextCursor === undefined || page.nextCursor === cursor) {
        refuse('unavailable', 'Pending observations are incomplete.', 'Reload before editing the catalog.')
      }
      cursor = page.nextCursor
    } while (true)
    const recentOpen: Record<string, T.SeatTimestamp> = {}
    for (const decision of engine.journal.projection.decisions) {
      for (const effect of decision.effects) {
        if (effect.kind === 'open/created' && effect.data.binding.kind === 'seat') {
          recentOpen[effect.data.binding.seat] = decision.observedAt
        }
      }
    }
    owner()
    const catalog = store.snapshot()
    return { revision: catalog.revision, authority: catalog.authority, definitions: catalog.definitions, windows, pending, recentOpen }
  }
  ctx.provide('seatProfilesLocal', Object.freeze({
    read,
    takeover: (request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }) => {
      const scoped = owner()
      return scoped.setAuthority({ expectedRevision: request.expectedRevision, operationId: request.operationId,
        authority: 'seat-store', authorizationRef: `owner-profile:${request.operationId}` as T.AuthorizationRef })
    },
    save: async (request: { definition: unknown; expectedRevision: number; operationId: T.SeatOperationId }) => {
      const scoped = owner(), definition = parseDefinition(request.definition)
      return 'status' in definition ? definition : scoped.save({ ...request, definition })
    },
    preview: (request: T.PreviewSeatImportRequest) => owner().previewImport(request),
    commit: (request: T.CommitSeatImportRequest) => owner().commitImport(request),
    remove: async (request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult> => {
      try {
        owner()
        const engine = ctx.get('seatEngine')
        if (!(engine instanceof SeatEngine)) refuse('unavailable', 'Seat engine is unavailable.', 'Restore the local engine.')
        const observed = await read()
        const sequence = engine.journal.projection.sequence
        const same = (left: readonly string[], right: readonly string[]) =>
          JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
        const revision = await store.mutate(request.expectedRevision, request.operationId, request, (catalog) => {
          owner()
          if (sequence !== engine.journal.projection.sequence) {
            refuse('revision-conflict', 'Engine activity changed during deletion.', 'Review the open windows and pending approvals again.')
          }
          if (!same(request.windows, observed.windows.filter(item => item.seat === request.seat).map(item => item.sessionId))
            || !same(request.pending, observed.pending.filter(item => item.seat === request.seat).map(item => item.queueItemId))) {
            refuse('revision-conflict', 'Deletion impact changed.', 'Review the open windows and pending approvals again.')
          }
          if (catalog.authority !== 'seat-store') refuse('import-source-authoritative', 'Import source owns this catalog.', 'Authorize a catalog takeover first.')
          if (!catalog.definitions.some(item => item.seat === request.seat)) refuse('seat-not-found', 'Seat definition is missing.', 'Reload the catalog.')
          catalog.definitions = catalog.definitions.filter(item => item.seat !== request.seat)
        })
        ctx.emit('seat/diagnostics-changed')
        return { status: 'saved', revision }
      } catch (error) {
        if (error instanceof SeatLocalError) return { status: 'rejected', error: error.failure }
        throw error
      }
    },
  }))
}
