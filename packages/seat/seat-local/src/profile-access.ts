/** Local owner capabilities for catalog editing and historical opening observations. */
import { type Context, Service } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '@panedesk/dsh-seat-engine'
import type { SeatProfileSnapshot, RemoveSeatProfileRequest } from './types.ts'
export type { SeatProfileSnapshot, SeatProfileWindow, RemoveSeatProfileRequest } from './types.ts'
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
 * @param ctx - Provider lifecycle; each access uses its caller's live invocation authority.
 * @param store - Catalog CAS owner.
 * @param service - Existing local seat operations.
 * @param options - Deployment-owned pagination and node identity.
 * @param runtime - Read-only window evidence for confirmation state versions.
 */
export function registerProfileAccess(ctx: Context, store: SeatStore, service: T.SeatService, options: LocalSeatOptions,
  runtime: Pick<LocalSeatRuntime, 'evidence'>): void {
  new LocalSeatProfileAccess(ctx, store, service, options, runtime)
}

class LocalSeatProfileAccess extends Service implements SeatProfileAccess {
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, private readonly store: SeatStore, private readonly service: T.SeatService,
    private readonly options: LocalSeatOptions, private readonly runtime: Pick<LocalSeatRuntime, 'evidence'>) {
    super(ctx, 'seatProfilesLocal')
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  private owner(): T.SeatService {
    if (this.lifetime.signal.aborted || this.ctx.invocation?.peer.principal.kind !== 'owner' || this.ctx.invocation.signal.aborted) {
      refuse('unauthorized', 'Authenticated owner required.', 'Sign in as the local owner.')
    }
    return this.service.withAuthority({ principalId: 'owner' as T.SeatPrincipalId, origin: 'manual', nodeId: this.options.nodeId })
  }

  async read(): Promise<SeatProfileSnapshot> {
    this.owner()
    const engine = this.ctx.get('seatEngine')
    if (!(engine instanceof SeatEngine)) refuse('unavailable', 'Opening history is unavailable.', 'Restore the local seat engine.')
    await engine.ready()
    const engineSequence = engine.journal.projection.sequence
    const windows: SeatProfileSnapshot['windows'] = [...engine.journal.projection.opens.values()].flatMap(open =>
      open.binding.kind === 'seat' && !engine.journal.projection.closed.has(open.sessionId)
        && !(open.phase === 'opening-failed' && open.failure?.effectState === 'none')
        ? [{ seat: open.binding.seat, sessionId: open.sessionId,
          title: open.title ?? open.binding.seat, nodeId: open.binding.nodeId, stateVersion: null, stateKnown: false }] : [])
    for (const window of windows) {
      const evidence = await this.runtime.evidence(window.sessionId)
      if (!evidence.complete) continue
      window.stateVersion = evidence.stateVersion
      window.stateKnown = true
    }
    const pending: SeatProfileSnapshot['pending'][number][] = []
    let cursor: T.EngineCursor | undefined
    do {
      this.owner()
      const page = await engine.pending({ limit: this.options.pageSize, ...(cursor === undefined ? {} : { cursor }) })
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
    this.owner()
    const catalog = this.store.snapshot()
    if (engineSequence !== engine.journal.projection.sequence) {
      refuse('revision-conflict', 'Engine activity changed during observation.', 'Refresh the profile observations.')
    }
    return { revision: catalog.revision, authority: catalog.authority, definitions: catalog.definitions,
      engineSequence, windows, pending, recentOpen }
  }
  takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult> {
    const scoped = this.owner()
    return scoped.setAuthority({ expectedRevision: request.expectedRevision, operationId: request.operationId,
      authority: 'seat-store', authorizationRef: `owner-profile:${request.operationId}` as T.AuthorizationRef })
  }

  async save(request: { definition: unknown; expectedRevision: number; operationId: T.SeatOperationId })
    : Promise<T.SeatCatalogMutationResult> {
    const scoped = this.owner(), definition = parseDefinition(request.definition)
    return 'status' in definition ? definition : scoped.save({ ...request, definition })
  }

  preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected> {
    return this.owner().previewImport(request)
  }

  commit(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult> {
    return this.owner().commitImport(request)
  }

  async remove(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult> {
    try {
      this.owner()
      const engine = this.ctx.get('seatEngine')
      if (!(engine instanceof SeatEngine)) refuse('unavailable', 'Seat engine is unavailable.', 'Restore the local engine.')
      const observed = await this.read()
      const sequence = engine.journal.projection.sequence
      const impact = (): string => digest({
        windows: [...engine.journal.projection.opens.values()].filter(open => open.binding.kind === 'seat' && open.binding.seat === request.seat)
          .map(open => ({ open, closed: engine.journal.projection.closed.has(open.sessionId) })),
        pending: [...engine.journal.projection.pending.values()].filter(item => item.seat === request.seat && item.reason === 'approval'),
      })
      const engineImpact = impact()
      const same = (left: readonly string[], right: readonly string[]) =>
        JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
      const revision = await this.store.mutate(request.expectedRevision, request.operationId, request, (catalog) => {
        this.owner()
        if (sequence !== engine.journal.projection.sequence) {
          refuse('revision-conflict', 'Engine activity changed during deletion.', 'Review the open windows and pending approvals again.')
        }
        const windows = observed.windows.filter(item => item.seat === request.seat)
        const pending = observed.pending.filter(item => item.seat === request.seat)
        if (windows.some(item => !item.stateKnown)) {
          refuse('evidence-unavailable', 'A window for this seat has unknown state.',
            'Open this window from the session list so it resumes, then retry.')
        }
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
          const evidence = await this.runtime.evidence(window.sessionId)
          if (!evidence.complete || window.stateVersion === null || evidence.stateVersion !== window.stateVersion) {
            refuse('revision-conflict', 'Window state changed after catalog deletion.', 'The definition was restored. Refresh and confirm again.')
          }
        }
        await engine.journal.commit(() => {
          this.owner()
          if (impact() !== engineImpact) refuse('revision-conflict', 'Engine activity changed after catalog deletion.',
            'The definition was restored. Refresh and confirm the current impact.')
          return []
        })
      })
      this.ctx.emit('seat/diagnostics-changed')
      return { status: 'saved', revision }
    } catch (error) {
      if (error instanceof SeatLocalError) return { status: 'rejected', error: error.failure }
      throw error
    }
  }
}
