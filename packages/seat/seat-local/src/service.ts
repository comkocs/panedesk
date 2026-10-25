/** SeatService orchestrates catalog policy and public engine operations under captured authority. */
import type { Context } from '@panedesk/cordis'
import { defineDomain, domainTable, type Domain } from '@panedesk/dsh-storage-domain'
import { z } from 'zod'
import { SeatService, type SeatEngineService } from '@panedesk/dsh-seat'
import type * as T from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { SeatStore, setCatalogAuthority, digest } from './store.ts'
import { SeatImporter } from './import.ts'
import { resolveSeat } from './schema.ts'
import { routeSeat } from './node-routing.ts'
import { DirectoryAdmission } from './directory-admission.ts'
import { openingContext, openingGate } from './open-gates.ts'
import { rejected, SeatLocalError, refuse } from './errors.ts'
import { LocalEngineState, localFact } from './engine-state.ts'
import { ReportStore, latestReport } from './report-store.ts'
import { WaitStore, projectedWaits } from './wait-store.ts'
import { WaitCoordinator } from './wait.ts'
import { CloseCoordinator } from './report.ts'
import { LocalCloser, closingState } from './closing-service.ts'
import { admitLocalOpen, localSourceId } from './open-admission.ts'
import { readLocalOpenInput } from './open-input.ts'
import { readContextUsage, remindContext } from './context-runtime.ts'
import { readWindowStatus, renewalRefusal } from './status.ts'
import { formatTemplateDate, readSeatText, renderOpening } from './template.ts'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
import { seatFrozenIdentity, querySeatFrozen } from './frozen-admission.ts'

const reminderSchema = z.object({ sessionId: z.string(), operationId: z.string(), text: z.string(), sent: z.boolean() })
const reminderSpec = defineDomain({ name: 'seat_close_reminders', version: 1, layout: 'per-record',
  tables: { reminders: domainTable(reminderSchema) } })

/** One provider owns catalog writes and recoverable observation subscriptions. */
export class LocalSeatService extends SeatService {
  private authority?: T.SeatCallContext
  /** Journal-backed state shared by this provider's recoverable operations. */
  readonly state: LocalEngineState
  /** Durable wait records used to restore observation subscriptions. */
  readonly waits: WaitStore
  private readonly importer: SeatImporter
  private readonly reports: ReportStore
  private readonly directories: DirectoryAdmission
  private readonly coordinator: WaitCoordinator
  private readonly closer: CloseCoordinator
  private readonly windowCloser: LocalCloser
  private reminderDomain?: Promise<Domain<typeof reminderSpec>>
  private reminderWork: Promise<void> = Promise.resolve()
  constructor(ctx: Context, private readonly store: SeatStore, readonly options: LocalSeatOptions,
    private readonly runtime: LocalSeatRuntime) {
    super(ctx)
    this.state = new LocalEngineState(() => this.engine(), options.nodeId, options.pageSize, options.transactionRetries)
    this.waits = new WaitStore(this.state)
    this.reports = new ReportStore(this.state)
    this.importer = new SeatImporter(store, runtime.catalogs, options)
    this.directories = new DirectoryAdmission(options.maxConfirmations)
    this.coordinator = new WaitCoordinator({ authorize: request => runtime.authorizeWait(request),
      register: request => this.waits.register(request), read: id => this.waits.read(id),
      observe: (id, observation) => this.waits.observe(id, observation), cancel: request => this.waits.cancel(request),
      snapshot: object => runtime.snapshot(object), subscribe: (object, listener) => runtime.subscribe(object, listener),
      wake: async (wait, delivery) => {
        await runtime.send({ sessionId: wait.sessionId, operationId: wait.wakeOperationId, text: delivery.text, mode: 'steer' })
        await this.waits.woken(wait.waitId)
      } })
    this.windowCloser = new LocalCloser(ctx, this.state, runtime, options)
    this.closer = new CloseCoordinator({ latest: async id => latestReport((await this.state.read()).effects, id),
      evidence: id => runtime.evidence(id),
      remind: (sessionId, operationId, text) => this.sendCloseReminder(sessionId, operationId, text),
      closeIfCurrent: (report, stateVersion) => this.windowCloser.close({ sessionId: report.sessionId,
        operationId: `${report.reportId}:close:${report.stateVersion}` as T.SeatOperationId,
        expectedStateVersion: stateVersion }, report) })
  }
  private sendCloseReminder(sessionId: SessionId, operationId: T.SeatOperationId, text: string): Promise<void> {
    const work = this.reminderWork.then(async () => {
      this.reminderDomain ??= (() => {
        const facility = this.runtime.context.get('storageDomain')
        if (!facility) throw new Error('Close reminder storage is unavailable')
        return facility.open(reminderSpec)
      })()
      const reminders = (await this.reminderDomain).table('reminders')
      const key = digest(operationId)
      let reminder = reminders.get(key)
      if (reminder?.sent) return
      if (!reminder) {
        reminder = { sessionId, operationId, text, sent: false }
        await reminders.put(key, reminder)
      }
      await this.runtime.send({ sessionId: reminder.sessionId as SessionId,
        operationId: reminder.operationId as T.SeatOperationId, text: reminder.text, mode: 'steer' })
      await reminders.put(key, { ...reminder, sent: true })
    })
    this.reminderWork = work.catch(() => {})
    return work
  }
  private engine(): SeatEngineService | undefined { return this.runtime.context.get('seatEngine') }
  private caller(): T.SeatCallContext {
    if (this.authority === undefined) refuse('unauthorized', 'Verified authority is required.', 'Use an authenticated seat adapter.')
    return this.authority
  }
  private async guard(nodeId?: T.SeatNodeId, operationId?: T.SeatOperationId): Promise<T.SeatRejected | null> {
    const authority = this.caller()
    if (authority.nodeId === this.options.nodeId && (nodeId === undefined || nodeId === this.options.nodeId)) return null
    const result = rejected('cross-node-unsupported', 'Live seat operations are local to this node.', 'Run the operation on its owning node.')
    if (this.engine() !== undefined) await this.state.mutate(effects => ({ result: undefined,
      effects: operationId !== undefined && effects.some(effect => effect.operationId === operationId) ? []
        : [localFact({ kind: 'open/rejected', ...(operationId === undefined ? {} : { operationId }),
          data: { error: result.error, candidates: [] } })] }))
    return result
  }
  private async result<R>(work: () => Promise<R>): Promise<R | T.SeatRejected> {
    try { return await work() }
    catch (error) {
      if (error instanceof SeatLocalError) return { status: 'rejected', error: error.failure }
      throw error
    }
  }
  override async nodeStatus(): Promise<T.SeatNodeStatus> {
    const engine = this.engine()
    if (engine !== undefined) { await engine.ready(); return engine.nodeStatus() }
    return { nodeId: this.options.nodeId, nodeName: this.options.nodeName, engine: 'unavailable',
      openEngineWindows: 0, limit: null, readyAt: null }
  }
  withAuthority(authority: T.SeatCallContext): SeatService {
    const scoped = Object.create(this) as LocalSeatService
    scoped.authority = Object.freeze({ ...authority })
    return scoped
  }
  async definitions(request: T.ListSeatDefinitionsRequest): Promise<T.ListSeatDefinitionsResult> {
    const refusal = await this.guard(request.nodeId)
    if (refusal !== null) throw new SeatLocalError(refusal.error)
    const catalog = this.store.snapshot()
    const offset = request.cursor === undefined ? 0 : Number(request.cursor.split(':')[1])
    if (request.cursor !== undefined && (request.cursor.split(':')[0] !== String(catalog.revision)
      || !Number.isSafeInteger(offset) || offset < 0)) refuse('query-cursor-invalid', 'Catalog cursor is stale.', 'Restart the catalog query.')
    const all = catalog.definitions.filter(item => request.projectId === undefined || item.projectId === request.projectId)
    const definitions = all.slice(offset, offset + this.options.pageSize)
    const complete = offset + definitions.length >= all.length
    return { definitions, revision: catalog.revision, complete,
      ...(complete ? {} : { nextCursor: `${catalog.revision}:${offset + definitions.length}` }) }
  }
  async resolve(seat: T.SeatName): Promise<T.SeatDefinition | T.SeatRejected> {
    const definition = this.store.snapshot().definitions.find(item => item.seat === seat)
    return definition === undefined ? rejected('seat-not-found', `No definition for seat ${seat}.`, 'Import or save the definition first.')
      : resolveSeat(definition, this.runtime.catalogs)
  }
  async save(request: T.SaveSeatDefinitionRequest): Promise<T.SeatCatalogMutationResult> {
    return this.result(async () => {
      const refusal = await this.guard(undefined, request.operationId)
      if (refusal !== null) return refusal
      const definition = await resolveSeat(request.definition, this.runtime.catalogs)
      if ('status' in definition) return definition
      const revision = await this.store.mutate(request.expectedRevision, request.operationId, request, (catalog) => {
        if (catalog.authority !== 'seat-store') refuse('import-source-authoritative', 'Import source owns this catalog.', 'Authorize a catalog takeover first.')
        const index = catalog.definitions.findIndex(item => item.seat === definition.seat)
        if (index < 0) catalog.definitions.push(definition)
        else catalog.definitions[index] = definition
      })
      return { status: 'saved' as const, revision }
    })
  }
  async previewImport(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected> {
    return this.result(async () => await this.guard() ?? this.importer.preview(request))
  }
  async commitImport(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult> {
    return this.result(async () => await this.guard(undefined, request.operationId) ?? this.importer.commit(request))
  }
  private async windows(): Promise<{ binding: Extract<T.SeatBinding, { kind: 'seat' }>; open: T.EngineOpenData }[]> {
    const effects = (await this.state.read()).effects
    const opened = new Map<SessionId, T.EngineOpenData>()
    const closed = new Set<SessionId>()
    for (const effect of effects) {
      if (effect.kind === 'open/created' || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') {
        opened.set(effect.data.sessionId, effect.data)
      }
      if (effect.kind === 'window/closed') closed.add(effect.data.sessionId)
    }
    return [...opened.values()].flatMap(open => open.binding.kind === 'seat' && !closed.has(open.sessionId)
      ? [{ binding: open.binding, open }] : [])
  }
  private async windowEngineStatus(open: T.EngineOpenData, complete: boolean): Promise<T.SeatEngineStatus> {
    const closing = closingState((await this.state.read()).effects, open.sessionId)
    if (closing && !closing.barrierReleased && closing.phase !== 'closed') return 'closing'
    const admission = await this.engine()?.admitTurn(open.sessionId)
    if (admission?.status === 'defer' && admission.reason === 'budget-stopped') return 'budget-stopped'
    if (!complete) return 'unknown'
    if (open.phase !== 'active' && open.phase !== 'opening-pending') return 'configuring'
    return open.openingMode === 'prefill' ? 'prefilled' : 'active'
  }
  async list(request: T.ListSeatWindowsRequest): Promise<T.ListSeatWindowsResult> {
    const refusal = await this.guard(request.nodeId)
    if (refusal !== null) return refusal
    if (this.engine() === undefined) return rejected('unavailable', 'Window evidence is unavailable.', 'Install the seat engine.')
    const windows = (await this.windows()).filter(item => request.projectId === undefined || item.binding.projectId === request.projectId)
    const fingerprint = digest(windows.map(item => item.open.sessionId))
    const offset = request.cursor === undefined ? 0 : Number(request.cursor.split(':')[1])
    if (request.cursor !== undefined && (request.cursor.split(':')[0] !== fingerprint || !Number.isSafeInteger(offset) || offset < 0)) {
      return rejected('query-cursor-invalid', 'Window cursor changed.', 'Restart the window query.')
    }
    const sessions = await Promise.all(windows.slice(offset, offset + this.options.pageSize).map(async ({ binding, open }) => {
      const evidence = await this.runtime.evidence(open.sessionId)
      const cache = await this.runtime.cache(open.sessionId)
      const status = readWindowStatus(evidence)
      const engineStatus = await this.windowEngineStatus(open, evidence.complete)
      const renewRejection = engineStatus === 'budget-stopped' || engineStatus === 'closing'
        ? rejected(engineStatus === 'budget-stopped' ? 'budget-stopped' : 'session-busy',
          `Window admission is ${engineStatus}.`, 'Resolve window admission before renewing.').error
        : renewalRefusal(evidence, cache, Date.now())
      const activity = evidence.lastActivityAt === null ? NaN : Date.parse(evidence.lastActivityAt)
      const view: T.SeatWindowView = { seat: binding.seat, sessionId: open.sessionId, nodeId: binding.nodeId,
        title: await this.runtime.title(open.sessionId) ?? open.title ?? binding.seat,
        ...status, engineStatus,
        evidence: evidence.complete ? 'complete' : 'unknown', idleMinutes: evidence.complete && !evidence.running && Number.isFinite(activity)
          ? Math.max(0, (Date.now() - activity) / 60000) : null,
        runningSubagents: evidence.subagents.length, activeJobs: evidence.jobs.length, canRenew: renewRejection === null,
        renewRejection, stateVersion: evidence.stateVersion, seatBinding: binding }
      return view
    }))
    const complete = offset + sessions.length >= windows.length
    return { status: 'listed', sessions, complete, snapshotAt: new Date().toISOString(),
      unopenedSeats: this.store.snapshot().definitions.filter(item =>
        (request.projectId === undefined || item.projectId === request.projectId)
        && !windows.some(window => window.binding.seat === item.seat)).map(item => item.seat),
      ...(complete ? {} : { nextCursor: `${fingerprint}:${offset + sessions.length}` }) }
  }
  async open(request: T.OpenSeatRequest): Promise<T.OpenSeatResult> {
    const definition = this.runtime.context.get('nodeRouter')
      ? this.store.snapshot().definitions.find(item => item.seat === request.seat) : undefined
    const target = request.nodeId ?? (definition ? this.options.nodeAliases[definition.node] : undefined)
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, target, this.caller(), 'seat.open', request)
    return routed ?? this.openResolved(request)
  }
  override async openFrozen(request: T.OpenFrozenSeatRequest): Promise<T.OpenFrozenSeatResult> {
    return this.openFrozenResolved(request, 'seat.openFrozen')
  }
  private async openFrozenResolved(request: T.OpenFrozenSeatRequest | T.WakeFrozenSeatRequest,
    method: 'seat.openFrozen' | 'seat.wakeFrozen'): Promise<T.OpenSeatResult> {
    const authority = this.caller(), chain = seatFrozenIdentity(request, authority, method)
    if ('status' in chain) return chain
    const original = querySeatFrozen((await this.state.read()).effects,
      { key: chain.operationKey, payloadDigest: chain.payloadDigest }, authority)
    if (original.status === 'rejected') return original
    if (original.status === 'settled') {
      if (original.method === 'seat.openFrozen') return structuredClone(original.result)
      if (original.method === 'seat.wakeFrozen' && original.result.status === 'opened') return structuredClone(original.result.result)
    }
    if (authority.nodeId !== this.options.nodeId) return rejected('cross-node-unsupported', 'Frozen admission is node-local.', 'Use the target node.')
    const engine = this.engine()
    if (!engine?.openWindow) return rejected('unavailable', 'Frozen admission is unavailable.', 'Restore the local engine.')
    const definition = await this.resolve(request.request.seat)
    if ('status' in definition) return definition
    if (this.options.nodeAliases[definition.node] !== this.options.nodeId) {
      return rejected('cross-node-unsupported', 'Frozen admission cannot route again.', 'Use the owning node.')
    }
    const snapshot = request.openingContext.snapshot
    if (Buffer.byteLength(snapshot.text) > this.options.maxOpeningBytes) {
      return rejected('source-payload-too-large', 'Frozen opening exceeds its byte limit.', 'Reduce the opening input.')
    }
    const date = formatTemplateDate(new Date(), this.runtime.context.get('seatGates')?.getTimeZone() ?? 'UTC')
    const base: T.OpenSeatRequest = 'origin' in request.request ? request.request
      : { seat: request.request.seat, operationId: request.request.operationId, origin: 'remote',
        ...(request.request.nodeId ? { nodeId: request.request.nodeId } : {}) }
    return engine.openWindow({ request: base, authority, definition, nodeWorkChain: chain,
      openingContext: snapshot, title: `${definition.seat} ${date.slice(5)}`,
      opening: { text: snapshot.text, digest: snapshot.digest, variables: { seat: definition.seat, date, taskId: base.taskId ?? null } } })
  }
  override async wakeFrozen(request: T.WakeFrozenSeatRequest): Promise<T.WakeFrozenSeatResult> {
    const authority = this.caller(), chain = seatFrozenIdentity(request, authority, 'seat.wakeFrozen')
    if ('status' in chain) return chain
    const original = querySeatFrozen((await this.state.read()).effects,
      { key: chain.operationKey, payloadDigest: chain.payloadDigest }, authority)
    if (original.status === 'rejected') return original
    if (original.status === 'settled' && original.method === 'seat.wakeFrozen') return structuredClone(original.result)
    const transactions = this.runtime.context.get('seatAuthorizationTransactions'), grant = authority.authorization
    if (!transactions?.validate || !grant) return rejected('unavailable', 'Frozen admission is unavailable.', 'Restore admission authority.')
    const refusal = await transactions.validate({ operationId: grant.fact.operationId, requestDigest: digest(request),
      ...(grant.fact.callId ? { callId: grant.fact.callId } : {}),
      ...(grant.fact.rootCallId ? { rootCallId: grant.fact.rootCallId } : {}) }, grant)
    if (refusal) return refusal
    return this.wakeResolved(request.request, () => this.openFrozenResolved(request, 'seat.wakeFrozen'))
  }
  /** Trusted source entries retain the complete local opening policy and durable admission.
   * @param request - Source reference and original opening parameters.
   * @param authority - Host-authenticated identity.
   * @param resolve - Registry-owned freezer.
   * @returns Original opening result.
   */
  openWithContext(request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext,
    resolve: (request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext) => Promise<T.OpeningContextSnapshot | T.SeatRejected>,
  ): Promise<T.OpenSeatResult> {
    const scoped = this.withAuthority(authority) as LocalSeatService
    const { openingContext: _reference, relatedTaskIds: _tasks, ...base } = request
    return scoped.openResolved(base, { request, resolve })
  }
  private async openResolved(request: T.OpenSeatRequest, context?: {
    request: T.OpenSeatWithContextRequest
    resolve: (request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext) => Promise<T.OpeningContextSnapshot | T.SeatRejected>
  }): Promise<T.OpenSeatResult> {
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return refusal
    const authority = this.caller()
    if (request.origin !== authority.origin) return rejected('unauthorized', 'Opening origin is not authenticated.', 'Use the trusted adapter origin.')
    if (this.engine() === undefined) return rejected('unavailable', 'Opening admission is unavailable.', 'Install the seat engine.')
    const facts = (await this.state.read()).effects
    const accepted = facts.find(effect => (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced')
      && effect.data.trigger.sourceId === localSourceId && effect.data.trigger.evidence.kind === 'manual'
      && effect.data.trigger.evidence.operationId === request.operationId)
    if (accepted?.kind === 'trigger/accepted' || accepted?.kind === 'trigger/coalesced') {
      const retained = readLocalOpenInput(accepted.data.trigger.data)
      const canonical = (value: T.OpenSeatRequest) => ({ seat: value.seat, origin: value.origin, taskId: value.taskId,
        nodeId: value.nodeId, openingMode: value.origin === 'manual' ? value.openingMode ?? 'auto' : 'auto',
        expectedSeatRevision: value.expectedSeatRevision })
      if (digest(canonical(request)) !== digest(canonical(retained.request))
        || digest(context ? { reference: context.request.openingContext, taskIds: [...context.request.relatedTaskIds].sort() } : null)
          !== digest(retained.openingContext ? { reference: retained.openingContext.reference,
            taskIds: [...retained.openingContext.taskIds].sort() } : null)) {
        return rejected('operation-id-conflict', 'Opening replay changed its original input.', 'Use the original request.')
      }
      const engine = this.engine()
      if (!engine) return rejected('unavailable', 'Opening recovery is unavailable.', 'Restore the engine.')
      return admitLocalOpen(engine, this.state, { ...retained, authority }, this.options.nodeName)
    }
    const replay = facts.find(effect => effect.operationId === request.operationId
      && (effect.kind === 'open/intent' || effect.kind === 'open/created' || effect.kind === 'open/configured'))
    if (replay?.kind === 'open/intent' || replay?.kind === 'open/created' || replay?.kind === 'open/configured') {
      const open = replay.data
      if (open.binding.kind !== 'seat' || open.binding.seat !== request.seat
        || open.definition === undefined || open.frozenOpening === undefined || open.title === undefined) {
        return rejected('operation-id-conflict', 'Opening replay does not match this seat.', 'Use the original request.')
      }
      return this.engine()?.openWindow?.({ request, authority, definition: open.definition,
        opening: open.frozenOpening, title: open.title })
        ?? rejected('unavailable', 'Opening admission is unavailable.', 'Restore the engine before replaying.')
    }
    const definition = await this.resolve(request.seat)
    if ('status' in definition) return definition
    if (request.expectedSeatRevision !== undefined && request.expectedSeatRevision !== definition.revision) {
      return rejected('revision-conflict', 'The seat definition changed.', 'Read the current definition.')
    }
    const engine = this.engine()
    if (engine === undefined) return rejected('unavailable', 'Opening admission is unavailable.', 'Install the seat engine.')
    const candidates = (await this.windows()).filter(item => item.binding.seat === request.seat)
      .map(({ open, binding }) => ({ seat: binding.seat, sessionId: open.sessionId,
        title: open.title ?? binding.seat, nodeId: binding.nodeId }))
    if (request.existingChoice !== undefined) {
      const choice = request.existingChoice
      if (choice.kind === 'cancel') return { status: 'cancelled' }
      const selected = candidates.find(item => item.sessionId === choice.sessionId)
      if (selected === undefined) return rejected('session-not-found', 'Selected window is not active for this seat.', 'List windows again.')
      if (choice.kind === 'switch') return { status: 'switched', window: selected }
      return { status: 'replacement', result: await this.replace({ sessionId: selected.sessionId, operationId: request.operationId }) }
    }
    if (candidates.length >= definition.maxOpenSessions && request.origin === 'manual') {
      return { status: 'choice-required', candidates, choices: ['switch', 'replace', 'cancel'], defaultChoice: 'switch' }
    }
    const startup = definition.directories.find(directory => directory.startup)
    if (!startup) return rejected('invalid-definition', 'Startup directory is unavailable.', 'Set the seat startup directory.')
    const gate = await openingGate(this.runtime.context, { ...openingContext(this.options.nodeId, request.operationId, request.seat),
      hook: 'before-open', cwd: startup.path, candidateSeats: [request.seat] })
    if (gate !== null) return gate
    const date = formatTemplateDate(new Date(), this.runtime.context.get('seatGates')?.getTimeZone() ?? 'UTC')
    const titleDate = date.slice(5)
    const snapshot = context ? await context.resolve(context.request, authority) : undefined
    if (snapshot && 'status' in snapshot) return snapshot
    const variables = { seat: definition.seat, date, taskId: request.taskId ?? null }
    const opening = snapshot ? { text: snapshot.text, digest: snapshot.digest, variables }
      : renderOpening(await readSeatText(definition.opening, this.options.maxOpeningBytes), variables, this.options.maxOpeningBytes)
    const input: T.SeatLocalOpenRequest = { request: authority.authorization ? request
      : { ...request, openingMode: request.origin === 'manual' ? request.openingMode ?? 'auto' : 'auto' },
    authority, definition, opening, title: `${definition.seat} ${titleDate}`,
    ...(snapshot ? { openingContext: snapshot } : {}) }
    return engine.openWindow ? engine.openWindow(input) : admitLocalOpen(engine, this.state, input, this.options.nodeName)
  }
  /** Check all task scopes before opening any batch member.
   * @param request - Authoritative evidence for every task.
   * @param authority - Original caller identity authenticated by the host.
   * @param evaluateTaskScopes - Trusted owner evaluator; absent registration preserves the default gate.
   * @returns Batch rejection or per-seat results.
   */
  openBatchWithScope(request: T.OpenSeatBatchWithScopeRequest, authority: T.SeatCallContext,
    evaluateTaskScopes?: T.OpeningScopeAdmission['evaluateTaskScopes']): Promise<T.OpenSeatBatchResult> {
    const { tasks, ...base } = request
    return (this.withAuthority(authority) as LocalSeatService).openBatchResolved(base, tasks, evaluateTaskScopes)
  }
  async openBatch(request: T.OpenSeatBatchRequest): Promise<T.OpenSeatBatchResult> {
    let target = request.nodeId
    if (this.runtime.context.get('nodeRouter') && this.runtime.context.get('nodeDelegationIssuer')) {
      if (!request.seats.length || request.seats.some(seat => !seat.trim() || /[*?]/.test(seat))
        || new Set(request.seats).size !== request.seats.length) {
        return rejected('batch-explicit-seats-required', 'List distinct seat names explicitly.', 'Use an explicit batch.')
      }
      if (request.seats.length > this.options.maxBatchSeats) {
        return rejected('batch-limit-exceeded', 'Batch exceeds the configured limit.', 'Split the explicit list.')
      }
      const nodes = new Set(request.seats.map((seat) => {
        const definition = this.store.snapshot().definitions.find(item => item.seat === seat)
        return definition ? this.options.nodeAliases[definition.node] : target
      }))
      if (nodes.size > 1 || (target !== undefined && [...nodes].some(node => node !== target))) {
        return rejected('cross-node-unsupported', 'Batch spans different node owners.', 'Submit one explicit batch per node.')
      }
      target ??= [...nodes][0]
    }
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, target, this.caller(), 'seat.openBatch', request)
    return routed ?? this.openBatchResolved(request)
  }
  private async openBatchResolved(request: T.OpenSeatBatchRequest,
    tasks?: readonly T.SeatTaskScopeContext[],
    evaluateTaskScopes?: T.OpeningScopeAdmission['evaluateTaskScopes']): Promise<T.OpenSeatBatchResult> {
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return refusal
    if (!request.seats.length || request.seats.some(seat => !seat.trim() || /[*?]/.test(seat))
      || new Set(request.seats).size !== request.seats.length) {
      return rejected('batch-explicit-seats-required', 'List distinct seat names explicitly.', 'Do not use an all or wildcard selection.')
    }
    if (request.seats.length > this.options.maxBatchSeats) return rejected('batch-limit-exceeded', 'Batch exceeds the configured limit.', 'Split the explicit list.')
    for (const seat of request.seats) { const definition = await this.resolve(seat); if ('status' in definition) return definition }
    const batchContext: Extract<T.GateContext, { hook: 'before-batch-open' }> = {
      ...openingContext(this.options.nodeId, request.operationId, null), hook: 'before-batch-open', seats: request.seats,
      ...(tasks === undefined ? {} : { tasks }) }
    if (tasks !== undefined) {
      const scopes = evaluateTaskScopes ? await evaluateTaskScopes({ ...batchContext, tasks })
        : await this.runtime.context.get('seatGates')?.evaluateTaskScopes?.({ ...batchContext, tasks })
      if (!scopes || scopes.outcome === 'deny') return rejected('gate-denied',
        scopes?.outcome === 'deny' ? scopes.reason : 'scope-unknown', 'serial')
    }
    const gate = await openingGate(this.runtime.context, batchContext)
    if (gate !== null) return gate
    const results: { seat: T.SeatName; result: T.OpenSeatResult }[] = []
    for (const seat of request.seats) {
      const taskId = evaluateTaskScopes ? tasks?.find(task => task.seat === seat)?.taskId : undefined
      results.push({ seat, result: await this.open({ ...request, seat, ...(taskId === undefined ? {} : { taskId }),
        operationId: `${request.operationId}:${seat}` as T.SeatOperationId }) })
    }
    return { status: 'processed', results }
  }
  async renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult> {
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, request.nodeId, this.caller(), 'seat.renew', request)
    if (routed !== undefined) return routed.status === 'rejected' && !('cacheEvidence' in routed)
      ? { ...routed, cacheEvidence: { lastActivityAt: null, cacheTtlMs: null, prefixDigest: null,
        observedAt: new Date().toISOString(), reusableRequest: false } } : routed
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return { ...refusal, cacheEvidence: { lastActivityAt: null, cacheTtlMs: null,
      prefixDigest: null, observedAt: new Date().toISOString(), reusableRequest: false } }
    const cacheEvidence = await this.runtime.cache(request.sessionId)
    const evidence = await this.runtime.evidence(request.sessionId)
    const renewalError = renewalRefusal(evidence, cacheEvidence, Date.now())
    if (renewalError !== null) return { status: 'rejected', error: renewalError, cacheEvidence }
    const engine = this.engine()
    if (engine === undefined) return { ...rejected('unavailable', 'Renewal accounting is unavailable.', 'Restore the engine before renewing.'), cacheEvidence }
    const grant = this.caller().authorization
    if (grant) return this.runtime.context.get('seatAuthorizedEngineActions')?.renew(request, grant)
      ?? { ...rejected('unavailable', 'Audited renewal is unavailable.', 'Restore authorization admission.'), cacheEvidence }
    return engine.renew({ ...request, source: 'manual' })
  }
  async close(request: T.CloseSeatRequest): Promise<T.CloseSeatResult> {
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, request.nodeId, this.caller(), 'seat.close', request)
    if (routed !== undefined) return routed
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return refusal
    return this.result(() => this.windowCloser.close(request, undefined, this.caller().authorization))
  }
  async replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult> {
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, request.nodeId, this.caller(), 'seat.replace', request)
    if (routed !== undefined) return routed
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return refusal
    const grant = this.caller().authorization
    if (grant) return this.runtime.context.get('seatAuthorizedEngineActions')?.replace(request, grant)
      ?? rejected('unavailable', 'Audited replacement is unavailable.', 'Restore authorization admission.')
    return this.engine()?.replace(request)
      ?? rejected('unavailable', 'Replacement admission is unavailable.', 'Restore the engine before replacing.')
  }
  async rename(request: T.RenameSeatRequest): Promise<T.RenameSeatResult> {
    if (this.caller().authorization) return rejected('unavailable', 'Atomic title authorization is unavailable.', 'Use a supported local entry.')
    return await this.guard(request.nodeId, request.operationId) ?? this.runtime.rename(request)
  }
  /** Keep context fallback inside the existing wake admission and window selection.
   * @param request - Original wake target.
   * @param authority - Host-authenticated identity.
   * @param open - Registry-owned fallback for a missing window.
   * @returns Existing wake result or trusted opening result.
   */
  wakeWithContext(request: T.WakeSeatRequest, authority: T.SeatCallContext,
    open: (request: T.OpenSeatRequest) => Promise<T.OpenSeatResult>): Promise<T.WakeSeatResult> {
    return (this.withAuthority(authority) as LocalSeatService).wakeResolved(request, open)
  }
  async wake(request: T.WakeSeatRequest): Promise<T.WakeSeatResult> {
    const selected = this.runtime.context.get('nodeRouter')
      ? this.store.snapshot().definitions.find(item => item.seat === request.seat) : undefined
    const targetNode = request.nodeId ?? (selected ? this.options.nodeAliases[selected.node] : undefined)
    const routed = await routeSeat(this.runtime.context, this.options.nodeId, targetNode, this.caller(), 'seat.wake', request)
    if (routed !== undefined) return routed
    return this.wakeResolved(request, input => this.open(input))
  }
  private async wakeResolved(request: T.WakeSeatRequest,
    open: (request: T.OpenSeatRequest) => Promise<T.OpenSeatResult>): Promise<T.WakeSeatResult> {
    const refusal = await this.guard(request.nodeId, request.operationId)
    if (refusal !== null) return refusal
    const definition = await this.resolve(request.seat)
    if ('status' in definition) return definition
    const candidates = (await this.windows()).filter(item => item.binding.seat === request.seat)
    if (!candidates.length) {
      if (request.sessionId !== undefined) return rejected('session-not-found', 'Selected window is no longer active.', 'List windows again.')
      return { status: 'opened', result: await open({ ...request, origin: this.caller().origin, openingMode: 'auto' }) }
    }
    const target = request.sessionId === undefined ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find(item => item.open.sessionId === request.sessionId)
    if (target === undefined && request.sessionId !== undefined) {
      return rejected('session-not-found', 'Selected window is not active for this seat.', 'List windows again.')
    }
    if (target === undefined) return { status: 'choice-required', candidates: candidates.map(({ open, binding }) => ({
      seat: binding.seat, sessionId: open.sessionId, nodeId: binding.nodeId, title: open.title ?? binding.seat })) }
    if (definition.wakeTemplate === undefined) return rejected('wake-template-missing', 'This seat has no wake template.', 'Configure a wake template.')
    const date = formatTemplateDate(new Date(), this.runtime.context.get('seatGates')?.getTimeZone() ?? 'UTC')
    const text = renderOpening(await readSeatText(definition.wakeTemplate, this.options.maxOpeningBytes),
      { seat: definition.seat, date, taskId: null }, this.options.maxOpeningBytes).text
    if (this.caller().authorization) return rejected('unavailable', 'Atomic wake authorization is unavailable.', 'Use a supported local entry.')
    const admission = await this.engine()?.admitTurn(target.open.sessionId)
    const sent = await this.runtime.send({ sessionId: target.open.sessionId, operationId: request.operationId, text, mode: 'queue' })
    return { status: admission?.status === 'defer' && admission.reason === 'budget-stopped' ? 'stored-budget-stopped' : 'sent',
      sessionId: target.open.sessionId, messageId: sent.messageId, operationId: request.operationId,
      title: await this.runtime.title(target.open.sessionId) ?? target.open.title ?? definition.seat }
  }
  async binding(request: T.SeatBindingRequest): Promise<T.SeatBinding | null | T.SeatRejected> {
    const refusal = await this.guard(request.nodeId)
    if (refusal !== null) return refusal
    let binding: T.SeatBinding | null = null
    for (const effect of (await this.state.read()).effects) {
      if (effect.kind === 'seat/binding' && effect.data.sessionId === request.sessionId) binding = effect.data
      if ((effect.kind === 'open/created' || effect.kind === 'open/configured') && effect.data.sessionId === request.sessionId) binding = effect.data.binding
    }
    return binding
  }
  async resolveDirectoryChoice(request: T.ResolveDirectoryChoiceRequest): Promise<T.DirectoryChoiceResult> {
    return await this.guard() ?? this.directories.resolve(request, this.caller().principalId, this.store.snapshot().definitions)
  }
  async submitReport(request: T.SubmitCloseReportRequest): Promise<T.CloseReportResult> {
    const refusal = await this.guard(undefined, request.operationId)
    if (refusal !== null) return refusal
    const result = await this.reports.submit(request, this.caller())
    if (result.status === 'recorded') await this.closer.evaluate(request.report.sessionId)
    return result
  }
  async revokeReport(request: T.RevokeCloseReportRequest): Promise<T.CloseReportResult> {
    return await this.guard(undefined, request.operationId) ?? this.reports.revoke(request, this.caller())
  }
  async registerWait(request: T.RegisterSeatWaitRequest): Promise<T.RegisterSeatWaitResult> {
    return await this.guard(undefined, request.operationId) ?? this.coordinator.register(request)
  }
  async cancelWait(request: T.CancelSeatWaitRequest): Promise<T.CancelSeatWaitResult> {
    return await this.guard(undefined, request.operationId) ?? this.coordinator.cancel(request)
  }
  wait(waitId: T.WaitId): Promise<T.SeatWait | null> { this.caller(); return this.waits.read(waitId) }
  async operation(request: T.SeatOperationQuery): Promise<T.SeatOperationResult> {
    this.caller()
    const transactions = this.ctx.get('seatAuthorizationTransactions')
    if (transactions?.operation) {
      const result = await transactions.operation(request)
      if (result.status !== 'missing') return result
    }
    const effects = (await this.state.read()).effects.filter(effect => effect.operationId === request.operationId)
    const last = effects.at(-1)
    if (last === undefined) return { status: 'missing' }
    if (last.kind === 'window/closed' && last.data.endedAt !== null) return { status: 'settled', result: {
      status: 'closed', sessionId: last.data.sessionId, phase: 'closed', endedAt: last.data.endedAt, stateVersion: last.data.stateVersion } }
    if (last.kind === 'open/rejected') return { status: 'settled', result: { status: 'rejected', error: last.data.error } }
    return { status: 'pending', phase: last.kind === 'window/replacement' ? last.data.phase : 'configuring', stateVersion: effects.length }
  }
  async contextUsage(sessionId: SessionId): Promise<T.SeatContextUsage> {
    this.caller()
    return readContextUsage(this.runtime.context, sessionId)
  }
  /** Restore committed reports and waits after engine readiness, without minting new identities.
   * @returns after subscriptions and current idle report evaluations are installed.
   */
  async recover(): Promise<void> {
    if (this.engine() === undefined) return
    const effects = (await this.state.read()).effects
    for (const wait of projectedWaits(effects).values()) await this.coordinator.watch(wait)
    const closing = new Set(effects.flatMap(effect => effect.kind === 'window/closing' ? [effect.data.sessionId] : []))
    for (const sessionId of closing) {
      const retained = closingState(effects, sessionId)
      if (retained && retained.phase !== 'closed' && !retained.barrierReleased && retained.operationId) {
        await this.windowCloser.close({ sessionId, operationId: retained.operationId, expectedStateVersion: retained.stateVersion })
      }
    }
    const sessions = new Set(effects.flatMap(effect => effect.kind === 'report/submitted' ? [effect.data.report.sessionId] : []))
    for (const sessionId of sessions) await this.closer.evaluate(sessionId)
  }
  /** Recheck reports after committed settlement; the event itself is not idle evidence.
   * @param sessionId - local window whose state changed.
   * @returns after current evidence has been checked.
   */
  async reevaluateReport(sessionId: SessionId): Promise<void> {
    await remindContext(this.runtime.context, this.state, this.runtime, sessionId)
    await this.closer.evaluate(sessionId)
  }
  /** Release observation ownership before catalog shutdown.
   * @returns after all accepted callbacks settle.
   */
  async stop(): Promise<void> {
    this.directories.dispose()
    await this.coordinator.dispose()
    await this.runtime.drainObservations?.()
    await this.windowCloser.drain()
    await this.reminderWork
    await (await this.reminderDomain)?.close()
    delete this.reminderDomain
  }
  /** Pause observation on engine unload while retaining recovery capability.
   * @returns after current subscriptions and callbacks drain.
   */
  async pause(): Promise<void> {
    await this.coordinator.pause(); await this.runtime.drainObservations?.(); await this.windowCloser.drain(); await this.reminderWork
  }
  async setAuthority(request: T.SetSeatAuthorityRequest): Promise<T.SeatCatalogMutationResult> {
    return this.result(async () => {
      const refusal = await this.guard(undefined, request.operationId)
      if (refusal !== null) return refusal
      const revision = await this.store.mutate(request.expectedRevision, request.operationId, request,
        (catalog) =>{  setCatalogAuthority(catalog, request.authority, request.authorizationRef) })
      return { status: 'saved' as const, revision }
    })
  }
}
