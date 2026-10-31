/** Local owner capabilities for catalog editing and historical opening observations. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import type { SeatProfileSnapshot, RemoveSeatProfileRequest } from './types.ts'
export type { SeatProfileSnapshot, RemoveSeatProfileRequest } from './types.ts'
import type { SeatStore } from './store.ts'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
import { refuse, SeatLocalError } from './errors.ts'
import { parseDefinition } from './schema.ts'
import { digest } from './store.ts'

/** Owner-only capabilities; every call checks live invocation authority. */
export interface SeatProfileAccess {
  /** Read catalog definitions and complete deletion impact.
   * @returns The current catalog and versioned window and approval observations.
   */
  read(): Promise<SeatProfileSnapshot>
  /** Transfer source-owned editing authority after confirmation.
   * @param request - Observed catalog revision and replay identity.
   * @returns The saved revision or a structured refusal.
   */
  takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult>
  /** Remove a confirmed definition while retaining its windows and approvals.
   * @param request - Catalog CAS and confirmed versioned impact.
   * @returns The saved revision or a structured refusal.
   */
  remove(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult>
  /** Save a complete definition under catalog CAS.
   * @param request - Definition, observed revision and replay identity.
   * @returns The saved revision or a structured refusal.
   */
  save(request: { definition: unknown; expectedRevision: number; operationId: T.SeatOperationId }): Promise<T.SeatCatalogMutationResult>
  /** Preview mapped source rows without importing them.
   * @param request - Source path, format, mapping and explicit defaults.
   * @returns A durable import plan or a structured refusal.
   */
  preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>
  /** Commit explicitly selected rows from an existing plan.
   * @param request - Plan identity, selected rows, catalog CAS and replay identity.
   * @returns The import receipt or a structured refusal.
   */
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
 * @param runtime - Read-only window evidence for confirmation state versions.
 */
export function registerProfileAccess(ctx: Context, store: SeatStore, service: T.SeatService, options: LocalSeatOptions,
  runtime: Pick<LocalSeatRuntime, 'evidence'>): void {
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
    const engineSequence = engine.journal.projection.sequence
    const windows: SeatProfileSnapshot['windows'] = [...engine.journal.projection.opens.values()].flatMap(open =>
      open.binding.kind === 'seat' && !engine.journal.projection.closed.has(open.sessionId)
        && !(open.phase === 'opening-failed' && open.failure?.effectState === 'none')
        ? [{ seat: open.binding.seat, sessionId: open.sessionId,
          title: open.title ?? open.binding.seat, nodeId: open.binding.nodeId, stateVersion: 0 }] : [])
    for (const window of windows) {
      const evidence = await runtime.evidence(window.sessionId)
      if (!evidence.complete) refuse('unavailable', 'Window state is unavailable.', 'Restore complete window evidence before editing.')
      window.stateVersion = evidence.stateVersion
    }
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
    if (engineSequence !== engine.journal.projection.sequence) {
      refuse('revision-conflict', 'Engine activity changed during observation.', 'Refresh the profile observations.')
    }
    return { revision: catalog.revision, authority: catalog.authority, definitions: catalog.definitions,
      engineSequence, windows, pending, recentOpen }
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
        const impact = (): string => digest({
          windows: [...engine.journal.projection.opens.values()].filter(open => open.binding.kind === 'seat' && open.binding.seat === request.seat)
            .map(open => ({ open, closed: engine.journal.projection.closed.has(open.sessionId) })),
          pending: [...engine.journal.projection.pending.values()].filter(item => item.seat === request.seat && item.reason === 'approval'),
        })
        const engineImpact = impact()
        const same = (left: readonly string[], right: readonly string[]) =>
          JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
        const revision = await store.mutate(request.expectedRevision, request.operationId, request, (catalog) => {
          owner()
          if (sequence !== engine.journal.projection.sequence) {
            refuse('revision-conflict', 'Engine activity changed during deletion.', 'Review the open windows and pending approvals again.')
          }
          const windows = observed.windows.filter(item => item.seat === request.seat)
          const pending = observed.pending.filter(item => item.seat === request.seat)
          if (request.engineSequence !== observed.engineSequence
            || digest(request.windowVersions) !== digest(windows.map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })))
            || digest(request.pendingVersions) !== digest(pending.map(({ queueItemId, stateVersion }) => ({ queueItemId, stateVersion })))
            || !same(request.windows, windows.map(item => item.sessionId))
            || !same(request.pending, pending.map(item => item.queueItemId))) {
            refuse('revision-conflict', 'Deletion impact changed.', 'Review the open windows and pending approvals again.')
          }
          if (catalog.authority !== 'seat-store') refuse('import-source-authoritative', 'Import source owns this catalog.', 'Authorize a catalog takeover first.')
          if (!catalog.definitions.some(item => item.seat === request.seat)) refuse('seat-not-found', 'Seat definition is missing.', 'Reload the catalog.')
          catalog.definitions = catalog.definitions.filter(item => item.seat !== request.seat)
        }, 'revision-conflict', undefined, async () => {
          for (const window of observed.windows.filter(item => item.seat === request.seat)) {
            const evidence = await runtime.evidence(window.sessionId)
            if (!evidence.complete || evidence.stateVersion !== window.stateVersion) {
              refuse('revision-conflict', 'Window state changed after catalog deletion.', 'The definition was restored. Refresh and confirm again.')
            }
          }
          await engine.journal.commit(() => {
            owner()
            if (impact() !== engineImpact) refuse('revision-conflict', 'Engine activity changed after catalog deletion.',
              'The definition was restored. Refresh and confirm the current impact.')
            return []
          })
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
