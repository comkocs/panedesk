/** Cordis engine provider owns journal lifecycle, policy, recovery and resource arbitration. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { SessionLedger } from '@panedesk/dsh-session-ledger'
import { SEAT_ENGINE_NAMESPACE, SeatEngineService, type SeatService } from '@panedesk/dsh-seat'
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, EngineError, digest, decodeFrame, canonical, frame } from './journal.ts'
import { SourceRegistry } from './sources.ts'
import { TriggerRegistry, rejected, fact } from './triggers.ts'
import { CallbackOutbox } from './outbox.ts'
import { effectiveMode, reserveOpen } from './admission.ts'
import { accountUsage, budgetLevel, projectBudget } from './budget.ts'
import { queryEngine, exportEngine, verifyEngine, redactPending } from './query.ts'
import { reconcileOpen } from './open-recovery.ts'
import { openLocalWindow } from './local-open.ts'
import { closeEffects } from './closing.ts'
import { queueReplacement, ReplacementDriver } from './replacement.ts'
import { KeepAliveScheduler, type KeepAliveRuntime } from './keepalive.ts'

/** Provider options add an explicit isolated storage home to validated deployment policy. */
export interface EngineOptions { home: string; nodeId: T.SeatNodeId; config: T.SeatEngineConfig }
/** Runtime providers are resolved on use, permitting optional composition and HMR. */
export interface EngineDependencies {
  seats(): Pick<SeatService, 'resolve' | 'list' | 'close'> | undefined
  ledger(): Pick<SessionLedger, 'snapshot'> | undefined
  /** Omitted runtime reports unavailable cache evidence and never dispatches maintenance. */
  keepalive?: KeepAliveRuntime
}
/** All durable engine operations share one native node owner and synchronized sequence. */
export class SeatEngine extends SeatEngineService {
  /** Single durable decision owner shared by all engine operations. */
  readonly journal: EngineJournal
  private readonly sources = new SourceRegistry()
  private readonly triggers: TriggerRegistry
  private readonly outbox: CallbackOutbox
  private readonly replacements: ReplacementDriver
  private readonly keepalive: KeepAliveScheduler
  private executor: T.SeatOpenExecutor | undefined
  private localAccess: T.SeatEngineLocalAccess | undefined
  private activeDrive: Promise<void> | undefined
  private activeCallbacks: Promise<void> | undefined
  private started: Promise<void> | undefined
  private readyAt: string | null = null
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private failure: unknown
  private readonly listeners = new Set<() => void>()
  constructor(ctx: Context, readonly options: EngineOptions, private readonly dependencies: EngineDependencies) {
    super(ctx)
    this.journal = new EngineJournal(join(options.home, 'ledger/engine/v1', options.nodeId),
      options.nodeId, options.config.maxDecisionBytes)
    this.triggers = new TriggerRegistry(this.journal, this.sources, options.config)
    this.outbox = new CallbackOutbox(this.journal, this.sources, options.config)
    this.replacements = new ReplacementDriver(this.journal, () => this.internalSeats(), options.config.nodeName)
    this.keepalive = new KeepAliveScheduler(this.journal, () => this.internalSeats(), dependencies.keepalive ?? {
      remaining: () => Promise.resolve({ kind: 'unknown' }),
      renew: () => Promise.resolve({ kind: 'rejected', reason: 'cache-evidence-unavailable' }),
    }, async sessionId => (await this.admitTurn(sessionId)).status !== 'allow')
  }
  async ready(): Promise<void> {
    this.started ??= this.start()
    return this.started
  }
  private async start(): Promise<void> {
    await this.journal.ready()
    for (const resource of this.journal.projection.resources.values()) this.recoveredOwners.add(resource.owner.ownerEpoch)
    this.readyAt = new Date().toISOString()
    await this.ctx.parallel('seat/ready', await this.nodeStatus())
    this.schedule()
  }
  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.drive().then(() =>{  this.schedule() }, (error: unknown) => { this.failure = error; this.schedule() })
    }, this.options.config.ownerObserveIntervalMs)
    this.timer.unref()
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.localOpenChain
    await this.activeDrive
    await this.outbox.close()
    await this.activeCallbacks
    await this.sources.close()
    await this.journal.close()
    for (const notify of this.listeners) notify()
  }
  private internalSeats(): Pick<SeatService, 'resolve' | 'list' | 'close'> | undefined {
    const seats = this.dependencies.seats(), access = this.localAccess
    return seats && access ? { resolve: seat => seats.resolve(seat), list: request => access.list(request),
      close: request => access.close(request) } : seats
  }
  override registerLocalAccess = (access: T.SeatEngineLocalAccess): (() => Promise<void>) => {
    if (this.localAccess) throw new EngineError('invalid-request', 'Local engine access is already registered')
    this.localAccess = access
    return async () => { if (this.localAccess === access) this.localAccess = undefined; await this.activeDrive }
  }
  private localOpenChain: Promise<void> = Promise.resolve()
  override openWindow = (input: T.SeatLocalOpenRequest): Promise<T.OpenSeatResult> => {
    const result = this.localOpenChain.then(() => this.openLocal(input))
    this.localOpenChain = result.then(() => undefined, () => undefined)
    return result
  }
  private async openLocal(input: T.SeatLocalOpenRequest): Promise<T.OpenSeatResult> {
    await this.ready()
    return openLocalWindow(this, input, async (envelope) => {
      if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
      if (this.options.config.nodeAliases[input.definition.node] !== this.options.nodeId) {
        return rejected('cross-node-unsupported', 'The seat belongs to another node')
      }
      if (this.localAccess?.preAdmit) {
        const refusal = await this.localAccess.preAdmit(input)
        if (refusal) return refusal
      }
      const frozenOpen: T.SeatFrozenOpen = { definition: input.definition, title: input.title,
        frozenOpening: input.opening, openingMode: input.request.origin === 'manual' ? input.request.openingMode ?? 'auto' : 'auto' }
      const rule = input.definition.rules.find(rule => rule.enabled && rule.trigger.kind === 'manual')
      const result = await this.triggers.accept(envelope, rule?.mode, frozenOpen)
      await this.publish()
      return result
    })
  }
  registerSource(source: T.SeatTriggerSource): () => Promise<void> { return this.sources.register(source) }
  registerExecutor(executor: T.SeatOpenExecutor): () => Promise<void> {
    if (this.executor) throw new EngineError('invalid-request', 'An open executor is already registered')
    this.executor = executor
    return async () => { if (this.executor === executor) this.executor = undefined; await this.activeDrive }
  }
  nodeStatus(): Promise<T.SeatNodeStatus> {
    return Promise.resolve({ nodeId: this.options.nodeId, nodeName: this.options.config.nodeName,
      engine: this.failure || this.stopped ? 'unavailable' : this.readyAt ? 'running' : 'recovering',
      openEngineWindows: [...this.journal.projection.resources.values()].reduce((sum, value) => sum + value.engineWindowUnits, 0),
      limit: this.options.config.nodeEngineWindowLimit ?? null, readyAt: this.readyAt })
  }
  async accept(envelope: T.TriggerEnvelope): Promise<T.AcceptTriggerResult> {
    await this.ready()
    if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
    const definition = await this.dependencies.seats()?.resolve(envelope.seat)
    if (!definition) return rejected('unavailable', 'Seat provider is unavailable')
    if ('status' in definition) return definition
    if (this.options.config.nodeAliases[definition.node] !== this.options.nodeId) {
      const result = rejected('cross-node-unsupported', 'The seat belongs to another node')
      await this.journal.commit(() => [fact({ kind: 'source/rejected', seat: envelope.seat, data: {
        sourceId: envelope.sourceId, sourceEventId: envelope.eventId ?? null, digest: digest(envelope.data), error: result.error,
      } })])
      await this.publish()
      return result
    }
    const receivedAt = new Date().toISOString()
    const frozenOpen = await this.localAccess?.freeze(definition, { ...envelope, receivedAt }) ?? {
      definition, title: `${envelope.seat} ${new Intl.DateTimeFormat('en-US', {
        timeZone: this.ctx.get('seatGates')?.getTimeZone() ?? 'UTC', month: '2-digit', day: '2-digit',
      }).format(new Date(receivedAt)).replace('/', '-')}`, openingMode: 'auto' as const }
    const rule = frozenOpen.definition.rules.find(rule => rule.enabled && rule.trigger.kind === envelope.kind)
    const result = await this.triggers.accept(envelope, rule?.mode, frozenOpen)
    await this.publish()
    return result
  }
  async auditSourceRejection(request: Parameters<SeatEngineService['auditSourceRejection']>[0]): Promise<void> {
    await this.ready()
    await this.journal.commit(() => [fact({ kind: 'source/rejected', data: {
      sourceId: request.sourceId, sourceEventId: null, digest: request.digest, error: request.error,
    } })], 0, { observedAt: request.observedAt })
    await this.publish()
  }
  private published = 0
  private async publish(): Promise<void> {
    const decisions = this.journal.projection.decisions.filter(decision => decision.sequence > this.published)
    for (const decision of decisions) {
      this.published = decision.sequence
      for (const notify of this.listeners) notify()
      try { await this.ctx.parallel('seat/decision', decision) } catch (error) { this.failure = error }
    }
  }
  async transact(request: T.EngineTransactionRequest): Promise<T.EngineTransactionResult> {
    await this.ready()
    const decision = decodeFrame(canonical(request.decision), this.options.config.maxDecisionBytes)
    let conflict: number | undefined
    let replay: T.EngineDecision | undefined
    const committed = await this.journal.commit((view) => {
      replay = view.decisions.find(item => item.decisionId === decision.decisionId)
      if (replay) return []
      if (view.sequence !== request.expectedSequence) { conflict = view.sequence; return [] }
      if (decision.nodeId !== this.options.nodeId || decision.sequence !== view.sequence + 1) throw new EngineError('invalid-request',
        'Decision does not target the current node sequence')
      return decision.effects
    }, decision.policyRevision, { decisionId: decision.decisionId, observedAt: decision.observedAt })
    await this.publish()
    const result = replay ?? committed
    return conflict !== undefined ? { status: 'conflict', actualSequence: conflict }
      : result ? { status: 'committed', decision: result } : rejected('invalid-request', 'Decision must contain effects')
  }
  async appendEffects(request: Parameters<SeatEngineService['appendEffects']>[0]): Promise<T.EngineTransactionResult> {
    let decision: T.EngineDecision
    try {
      decision = decodeFrame(canonical(frame({ namespace: SEAT_ENGINE_NAMESPACE, schemaVersion: 1,
        decisionId: request.decisionId, sequence: request.expectedSequence + 1, nodeId: this.options.nodeId,
        observedAt: request.observedAt, policyRevision: request.policyRevision, effects: request.effects,
      })), this.options.config.maxDecisionBytes)
    } catch (error) {
      if (!(error instanceof EngineError || error instanceof TypeError || error instanceof RangeError)) throw error
      return rejected('invalid-request', 'Decision effects cannot be encoded or validated')
    }
    return this.transact({ expectedSequence: request.expectedSequence, decision })
  }
  async projectPolicy(projectId: T.SeatProjectId): Promise<T.SeatProjectPolicy> {
    await this.ready()
    return this.journal.projection.policies.get(projectId) ?? { projectId, mode: 'remind', modeChosen: false, revision: 0 }
  }
  async setProjectMode(request: T.SetProjectModeRequest): Promise<T.SetProjectModeResult> {
    await this.ready()
    let result: T.SetProjectModeResult = rejected('revision-conflict', 'Project policy revision changed')
    await this.journal.commit((view) => {
      const previous = view.policies.get(request.projectId) ?? { projectId: request.projectId,
        mode: 'remind', modeChosen: false, revision: 0 }
      if (previous.revision !== request.expectedRevision) return []
      const policy = { ...previous, mode: request.mode, modeChosen: true, revision: previous.revision + 1 }
      result = { status: 'saved', policy }
      return [fact({ kind: 'mode/changed', operationId: request.operationId, data: { policy,
        previousMode: previous.mode, previousRevision: previous.revision, principalId: 'engine-policy' as T.SeatPrincipalId } })]
    })
    await this.publish()
    return result
  }
  async pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult> {
    await this.ready()
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request',
      'Pending limit must be positive')
    const all = [...this.journal.projection.pending.values()].sort((a, b) => a.sequence - b.sequence)
      .filter(item => (!request.projectId || item.projectId === request.projectId) && (!request.seat || item.seat === request.seat)
        && (!request.cursor || item.sequence > request.cursor.sequence))
    const items = all.slice(0, request.limit).map(redactPending)
    const last = items.at(-1)
    return { items, complete: all.length <= request.limit, watermark: this.journal.projection.sequence,
      ...(last ? { nextCursor: { nodeId: this.options.nodeId, sequence: last.sequence, effectIndex: 0 } } : {}) }
  }
  private async mutatePending(request: T.ApprovePendingSeatRequest, kind: 'queue/approved' | 'queue/cancelled'): Promise<T.PendingSeatMutationResult> {
    await this.ready()
    let result: T.PendingSeatMutationResult = rejected('revision-conflict', 'Pending state changed')
    await this.journal.commit((view) => {
      const previous = view.pending.get(request.queueItemId)
      if (!previous || previous.stateVersion !== request.expectedStateVersion) return []
      const pending = { ...previous, stateVersion: previous.stateVersion + 1 }
      result = { status: kind === 'queue/approved' ? 'approved' : 'cancelled', queueItemId: pending.queueItemId,
        stateVersion: pending.stateVersion }
      return [fact({ kind, operationId: request.operationId, data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId,
        previousRevision: previous.stateVersion, revision: pending.stateVersion } })]
    })
    await this.publish()
    return result
  }
  approve(request: T.ApprovePendingSeatRequest): Promise<T.PendingSeatMutationResult> { return this.mutatePending(request,
    'queue/approved') }
  cancel(request: T.CancelPendingSeatRequest): Promise<T.PendingSeatMutationResult> { return this.mutatePending(request,
    'queue/cancelled') }
  async query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult> { await this.ready()
    return queryEngine(this.journal.projection.decisions, request) }
  async export(request: T.EngineExportRequest): Promise<T.EngineExportResult> { await this.ready()
    return exportEngine(this.journal.projection.decisions, request) }
  verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult> { return verifyEngine(request.input,
    this.options.config.maxDecisionBytes) }
  async *subscribe(cursor?: T.EngineCursor): AsyncIterable<T.EngineDecision> {
    await this.ready()
    let sequence = cursor?.sequence ?? 0
    while (!this.stopped) {
      let wake!: () => void
      const changed = new Promise<void>((resolve) => { wake = resolve })
      this.listeners.add(wake)
      try {
        const available = this.journal.projection.decisions.filter(decision => decision.sequence > sequence)
        for (const decision of available) { sequence = decision.sequence; yield decision }
        if (!available.length) await changed
      } finally { this.listeners.delete(wake) }
    }
  }
  async budget(sessionId: SessionId): Promise<T.SeatBudgetSnapshot> {
    await this.ready()
    const current = this.journal.projection.budgets.get(sessionId)
    if (!current) throw new EngineError('session-not-found', 'Window budget does not exist')
    return this.readBudget(sessionId, current.seat, current.limits, current.budgetRevision)
  }
  private async readBudget(sessionId: SessionId, seat: T.SeatName, limits: T.SeatBudgetLimits,
    budgetRevision = 0): Promise<T.SeatBudgetSnapshot> {
    const ledger = this.dependencies.ledger()
    const snapshot = ledger ? await ledger.snapshot() : { rows: [], complete: false, asOf: 0, watermarks: {} }
    return projectBudget(snapshot, { sessionId, seat, limits, budgetRevision, budgetTimeZone: this.options.config.budgetTimeZone,
      now: Date.now() })
  }
  async configureBudget(request: T.ConfigureSeatBudgetRequest): Promise<T.ConfigureSeatBudgetResult> {
    const budget = await this.budget(request.sessionId)
    if (budget.budgetRevision !== request.expectedRevision) return rejected('revision-conflict', 'Budget revision changed')
    const updated = { ...budget, limits: request.limits, budgetRevision: budget.budgetRevision + 1 }
    const committed = await this.journal.commit((view) => {
      if (view.budgets.get(request.sessionId)?.budgetRevision !== request.expectedRevision) return []
      return [fact({ kind: 'budget/reconfigured', sessionId: request.sessionId, operationId: request.operationId,
        data: { budget: updated, previousRevision: budget.budgetRevision, authorizationRef: request.authorizationRef } })]
    })
    await this.publish()
    return committed ? { status: 'configured', budget: updated } : rejected('revision-conflict', 'Budget revision changed')
  }
  async accountUsage(request: T.SeatAccountUsageRequest): Promise<T.SeatAccountUsageResult> {
    const ledger = this.dependencies.ledger()
    if (!ledger) return { accounts: [], watermark: 0, complete: false, queryCommand: 'dsh --profile ledger query --group-by account' }
    return accountUsage(await ledger.snapshot({ from: Date.parse(request.from), to: Date.parse(request.to),
      ...(request.nodeId ? { nodeId: request.nodeId } : {}) }))
  }
  async ticket(ticketId: T.ChildTicketId): Promise<T.ChildAdmissionTicket | null> {
    await this.ready(); return this.journal.projection.children.get(ticketId) ?? null
  }
  async admitChild(request: T.AdmitSeatChildRequest): Promise<T.ChildAdmissionResult> {
    await this.ready()
    let result: T.ChildAdmissionResult = rejected('unavailable', 'Child admission did not commit')
    await this.journal.commit((view) => {
      const existing = view.children.get(request.ticket.ticketId)
      if (existing) {
        result = existing.requestDigest !== request.ticket.requestDigest ? rejected('operation-id-conflict', 'Child identity conflicts')
          : existing.phase === 'admitted' && existing.childSessionId ? { status: 'admitted',
            ticket: existing, childSessionId: existing.childSessionId }
            : existing.phase === 'queued' ? { status: 'queued', ticket: existing } : rejected('ticket-cancelled',
              'Child ticket has settled')
        return []
      }
      const siblings = [...view.children.values()].filter(ticket => ticket.parentSessionId === request.ticket.parentSessionId)
      const allowed = siblings.filter(ticket => ticket.phase === 'admitted').length < request.maxActive && !siblings.some(ticket => ticket.phase === 'queued')
      const ticket: T.ChildAdmissionTicket = { ...request.ticket, sequence: view.sequence + 1,
        phase: allowed ? 'admitted' : 'queued', stateVersion: 1,
        childSessionId: allowed ? request.ticket.childSessionId ?? randomUUID() as SessionId : null }
      result = allowed ? { status: 'admitted', ticket, childSessionId: ticket.childSessionId as SessionId } : { status: 'queued', ticket }
      return [fact({ kind: allowed ? 'child/admitted' : 'child/queued', data: ticket })]
    })
    await this.publish(); return result
  }
  async releaseChild(ticketId: T.ChildTicketId): Promise<void> {
    await this.ready()
    await this.journal.commit((view) => {
      const ticket = view.children.get(ticketId)
      if (!ticket || ticket.phase !== 'admitted') return []
      const next = [...view.children.values()].filter(item => item.parentSessionId === ticket.parentSessionId && item.phase === 'queued').sort((a,
        b) => a.sequence - b.sequence)[0]
      return [fact({ kind: 'child/released', data: { ...ticket, phase: 'released', stateVersion: ticket.stateVersion + 1 } }),
        ...(next ? [fact({ kind: 'child/admitted', data: { ...next, phase: 'admitted', childSessionId: randomUUID() as SessionId,
          stateVersion: next.stateVersion + 1 } })] : [])]
    })
    await this.publish()
  }
  async cancelTicket(request: T.CancelChildTicketRequest): Promise<T.CancelChildTicketResult> {
    await this.ready()
    let result: T.CancelChildTicketResult = rejected('revision-conflict', 'Child ticket changed')
    await this.journal.commit((view) => {
      const ticket = view.children.get(request.ticketId)
      if (!ticket || ticket.parentSessionId !== request.parentSessionId || ticket.stateVersion !== request.expectedStateVersion) return []
      if (ticket.phase === 'admitted') { result = { status: 'already-admitted', ticket }; return [] }
      const cancelled: T.ChildAdmissionTicket = { ...ticket, phase: 'cancelled', stateVersion: ticket.stateVersion + 1 }
      result = { status: 'cancelled', ticket: cancelled }
      return [fact({ kind: 'child/released', operationId: request.operationId, data: cancelled })]
    })
    await this.publish(); return result
  }
  async replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult> {
    await this.ready()
    if (request.nodeId && request.nodeId !== this.options.nodeId) return rejected('cross-node-unsupported', 'Replacement is node-local')
    const result = await queueReplacement(this.journal, request)
    await this.publish()
    return result
  }
  async renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult> {
    await this.ready()
    const evidence = await this.dependencies.keepalive?.remaining(request.sessionId)
    const cacheEvidence: T.SeatCacheEvidence = { lastActivityAt: evidence?.kind === 'estimated'
      ? new Date(evidence.evidenceAt).toISOString() : null, cacheTtlMs: evidence?.kind === 'estimated'
      ? evidence.ttlSeconds * 1000 : null, prefixDigest: null, observedAt: new Date().toISOString(),
    reusableRequest: evidence?.kind === 'estimated' }
    if (request.nodeId && request.nodeId !== this.options.nodeId) return {
      ...rejected('cross-node-unsupported', 'Maintenance is node-local'), cacheEvidence }
    if (!this.journal.projection.resources.has(request.sessionId)) return {
      ...rejected('session-not-found', 'Maintenance window is not active'), cacheEvidence }
    if ((await this.admitTurn(request.sessionId)).status !== 'allow') return {
      ...rejected('budget-stopped', 'Maintenance is blocked by window admission'), cacheEvidence }
    const result = await this.keepalive.renew(request.sessionId, request.operationId, 'manual',
      evidence?.kind === 'estimated' ? evidence.evidenceAt : null, null)
    await this.publish()
    if (result.phase === 'renewed') return { status: 'renewed', sessionId: request.sessionId,
      cacheEvidence: { ...cacheEvidence, lastActivityAt: result.evidenceAt === null ? null : new Date(result.evidenceAt).toISOString() } }
    if (result.phase === 'uncertain') return { status: 'uncertain',
      error: rejected('renewal-uncertain', 'Maintenance outcome is unconfirmed').error, cacheEvidence }
    const code: T.SeatErrorCode = result.reason === 'busy' ? 'maintenance-busy' : result.reason === 'cache-expired'
      ? 'cache-expired' : result.reason === 'prefix-changed' ? 'cache-prefix-changed' : 'cache-evidence-unavailable'
    return { ...rejected(code, 'Maintenance was not dispatched'), cacheEvidence }
  }
  async recordClosed(closed: T.EngineCloseData): Promise<void> {
    await this.ready()
    await this.journal.commit(view => closeEffects(view, closed, this.options.config.nodeName))
    await this.publish()
  }
  drive(): Promise<void> {
    if (this.activeDrive) return this.activeDrive
    this.activeDrive = this.run().finally(() => { this.activeDrive = undefined })
    return this.activeDrive
  }
  private async run(): Promise<void> {
    await this.ready()
    if (this.stopped) return
    const executor = this.executor
    if (executor) {
      await this.releaseDead(executor)
      for (const item of [...this.journal.projection.pending.values()].sort((a, b) => a.sequence - b.sequence)) await this.dispatch(item,
        executor)
      // Publish each durable checkpoint before its next external Session effect.
      await this.publish()
      const recoveryExecutor: T.SeatOpenExecutor = { ...executor,
        configure: async (open, stage) => { await this.publish(); await executor.configure(open, stage) },
        opening: async (open) => { await this.publish(); return executor.opening(open) },
      }
      for (const open of [...this.journal.projection.opens.values()]) {
        if (!this.journal.projection.resources.has(open.sessionId)) continue
        let recovered: T.EngineOpenData
        try { recovered = await reconcileOpen(this.journal, open, recoveryExecutor, current => this.callbacks(current, 'opened')) }
        catch (error) {
          const replacement = [...this.journal.projection.replacements.values()].find(item => item.newSessionId === open.sessionId)
          if (!replacement || !(error instanceof EngineError) || !['open-create-failed', 'open-configuration-failed'].includes(error.code)) throw error
          recovered = { ...open, phase: 'opening-failed', failure: rejected('replacement-open-failed', 'Replacement creation failed').error }
          await this.journal.commit(() => [fact({ kind: 'open/opening-failed', sessionId: open.sessionId, data: recovered })])
        }
        if (recovered.phase === 'opening-failed') await this.recordCallbacks(recovered, 'opening-failed')
        await this.refreshBudget(recovered, executor)
      }
      await this.replacements.drive(executor)
    }
    await this.keepalive.drive()
    this.activeCallbacks ??= this.outbox.deliver().then(() => this.publish())
      .catch((error: unknown) => { this.failure = error }).finally(() => { this.activeCallbacks = undefined })
    await this.publish()
  }
  private async releaseDead(executor: T.SeatOpenExecutor): Promise<void> {
    for (const resource of [...this.journal.projection.resources.values()]) {
      const open = this.journal.projection.opens.get(resource.owner.sessionId)
      if (!open) continue
      const start = performance.now(), observedAt = new Date().toISOString()
      if (await executor.owner(resource.owner) !== 'dead') continue
      const recovered = this.recoveredOwners.has(resource.owner.ownerEpoch)
      await this.journal.commit(view => view.resources.get(resource.owner.sessionId)?.owner.ownerEpoch !== resource.owner.ownerEpoch
        ? [] : [fact({
          kind: 'resource/released', sessionId: resource.owner.sessionId, seat: resource.seat,
          data: { owner: resource.owner, reason: recovered ? 'host-restart-recovery' : 'holder-death', observedAt,
            engineReadyAt: recovered ? this.readyAt : null, releasedAt: new Date().toISOString(), fenced: true },
        })])
      if (performance.now() - start > this.options.config.ownerReleaseBudgetMs) this.failure = new EngineError('unavailable',
        'Owner release exceeded its configured time budget')
    }
  }
  private async dispatch(item: T.PendingSeatItem, executor: T.SeatOpenExecutor): Promise<void> {
    const definition = item.frozenOpen?.definition ?? await this.dependencies.seats()?.resolve(item.seat)
    if (!definition || 'status' in definition) return
    const rule = definition.rules.find(rule => rule.enabled && rule.trigger.kind === item.triggerKind)
    const livePolicy = item.triggerKind === 'manual' ? undefined : await this.dependencies.seats()?.resolve(item.seat)
    const ruleMode = livePolicy && !('status' in livePolicy)
      ? livePolicy.rules.find(rule => rule.enabled && rule.trigger.kind === item.triggerKind)?.mode : rule?.mode
    const sessionId = randomUUID() as SessionId
    const budget = await this.readBudget(sessionId, item.seat, {
      ...(rule?.windowBudgetUsd !== undefined ? { windowBudgetUsd: rule.windowBudgetUsd } : {}),
      ...(rule?.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: rule.dailyBudgetUsd } : {}) })
    const action = { wake: false }
    await this.journal.commit((view) => {
      const current = view.pending.get(item.queueItemId)
      if (!current) return []
      const policy = view.policies.get(item.projectId)
      const mode = item.triggerKind === 'manual' ? 'auto' : effectiveMode(policy?.mode ?? 'remind', ruleMode)
      const pending = (reason: T.PendingReason, blockedBy: readonly string[] = []): T.EngineEffect[] => {
        if (current.reason === reason && current.effectiveMode === mode && canonical(current.blockedBy) === canonical(blockedBy)) return []
        return [fact({ kind: 'queue/pending', seat: item.seat, data: { ...current, effectiveMode: mode,
          reason, blockedBy, stateVersion: current.stateVersion + 1 } })]
      }
      if (mode === 'off') return pending('project-off')
      if (mode === 'remind' && !view.approved.has(item.queueItemId)) return pending('approval')
      if (item.action === 'wake-sender') { action.wake = true; return [] }
      const replacement = item.replacementId ? view.replacements.get(item.replacementId) : undefined
      const oldResource = replacement ? view.resources.get(replacement.oldSessionId) : undefined
      if (item.action === 'replace' && (!replacement || !oldResource)) return pending('provider-unavailable')
      const permit: T.HandoverPermit | undefined = replacement && oldResource ? {
        permitId: randomUUID() as T.HandoverPermitId, replacementId: replacement.replacementId,
        oldSessionId: replacement.oldSessionId, newSessionId: sessionId, state: 'issued',
        issuedAt: new Date().toISOString(), expiredAt: null, ownerEpoch: oldResource.owner.ownerEpoch,
      } : undefined
      const engineWindow = oldResource ? oldResource.engineWindowUnits > 0 : item.triggerKind !== 'manual'
      const admission = reserveOpen({ projection: view, definition, ...(rule ? { rule } : {}),
        ...(permit ? { replacement: permit } : {}),
        nodeId: this.options.nodeId, aliases: this.options.config.nodeAliases,
        engine: engineWindow, now: Date.now(),
        ...(this.options.config.nodeEngineWindowLimit !== undefined ? { nodeLimit: this.options.config.nodeEngineWindowLimit } : {}),
        budget, sessionId })
      if (admission.status === 'pending') return pending(admission.reason, admission.blockedBy)
      if (admission.status === 'rejected') return [fact({ kind: 'open/rejected', seat: item.seat,
        data: { error: rejected(admission.code, 'Window admission refused').error, candidates: [] } }),
      fact({ kind: 'queue/cancelled', data: { pending: current, principalId: 'engine-policy' as T.SeatPrincipalId,
        previousRevision: current.stateVersion, revision: current.stateVersion + 1 } })]
      const intentId = randomUUID() as T.OpenIntentId, operationId = randomUUID() as T.SeatOperationId
      const binding: T.SeatBinding = { kind: 'seat', sessionId, seat: item.seat, projectId: item.projectId, nodeId: this.options.nodeId,
        bindingSource: 'seat-definition', identitySource: 'settings', openOperationId: operationId, seatRevision: definition.revision,
        ...(item.relatedTaskIds[0] ? { taskId: item.relatedTaskIds[0] } : {}), relatedTaskIds: item.relatedTaskIds,
        directories: definition.directories,
        memoryDirectories: definition.memoryDirectories, subscriptions: definition.subscriptions,
        openingDigest: item.frozenOpen?.frozenOpening?.digest ?? digest(definition.opening) }
      const date = new Intl.DateTimeFormat('en-US', { timeZone: this.ctx.get('seatGates')?.getTimeZone() ?? 'UTC',
        month: '2-digit', day: '2-digit' }).format(new Date()).replace('/', '-')
      const open: T.EngineOpenData = { intentId, sessionId, seatRevision: definition.revision,
        phase: 'intent', completedStages: [], binding,
        openingOperationId: operationId, openingMessageId: null, openingDigest: binding.openingDigest, budget, failure: null, definition,
        sources: current.sources, title: item.frozenOpen?.title ?? `${item.seat} ${date}`,
        ...(item.frozenOpen ? { openingMode: item.frozenOpen.openingMode,
          ...(item.frozenOpen.frozenOpening ? { frozenOpening: item.frozenOpen.frozenOpening } : {}) } : {}) }
      return [
        ...(replacement && permit ? [fact({ kind: 'window/replacement', data: { ...replacement,
          newSessionId: sessionId, phase: 'opening', permit, pending: null } })] : []),
        fact({ kind: 'queue/cancelled', data: { pending: current, principalId: 'engine-policy' as T.SeatPrincipalId,
          previousRevision: current.stateVersion, revision: current.stateVersion + 1 } }),
        fact({ kind: 'open/intent', seat: item.seat, sessionId, ...(item.sources[0] ? { triggerId: item.sources[0].triggerId } : {}),
          data: open }),
        fact({ kind: 'resource/reserved', seat: item.seat, sessionId, data: { owner: { sessionId,
          intentId, ownerEpoch: randomUUID() as T.OwnerEpoch, resourceRevision: 1 },
        nodeId: this.options.nodeId, seat: item.seat, exclusiveTags: admission.tags, engineWindowUnits: engineWindow ? 1 : 0,
        seatWindowUnits: 1 } })]
    })
    if (action.wake && item.handoffTimeout && await executor.wakeSender(item.handoffTimeout) !== 'unavailable') {
      const current = this.journal.projection.pending.get(item.queueItemId)
      if (current) await this.cancel({ queueItemId: item.queueItemId, expectedStateVersion: current.stateVersion,
        operationId: item.handoffTimeout.wakeOperationId })
    }
  }
  private callbacks(open: T.EngineOpenData, kind: 'opened' | 'opening-failed' | 'budget-stopped',
    snapshot = open.budget): T.SeatCallbackDelivery[] {
    if (open.binding.kind !== 'seat') return []
    const binding = open.binding
    return (open.sources ?? []).map((source) => {
      const base: T.SeatCallbackBase = { callbackId: digest([open.intentId, source.triggerId,
        kind, kind === 'budget-stopped' ? snapshot.budgetRevision : 0]) as string as T.CallbackId,
      sourceId: source.sourceId, triggerId: source.triggerId, stateVersion: this.journal.projection.sequence + 1, seat: binding.seat,
      title: open.title ?? binding.seat, sessionId: open.sessionId, nodeId: binding.nodeId, nodeName: this.options.config.nodeName,
      budget: snapshot.limits, ...(source.taskId ? { taskId: source.taskId } : {}), relatedTaskIds: binding.relatedTaskIds }
      const payload: T.SeatCallbackPayload = kind === 'opened' ? { ...base, kind, sessionId: open.sessionId,
        title: open.title ?? binding.seat }
        : kind === 'opening-failed' ? { ...base, kind, reason: open.failure ?? rejected('opening-failed', 'Opening failed').error }
          : { ...base, kind, budgetSnapshot: snapshot }
      return { payload, payloadDigest: digest(payload), attempt: 0, phase: 'pending', nextDue: null, responseClass: null }
    })
  }
  private async recordCallbacks(open: T.EngineOpenData, kind: 'opening-failed' | 'budget-stopped', snapshot = open.budget): Promise<void> {
    const callbacks = this.callbacks(open, kind, snapshot)
    await this.journal.commit(view => callbacks.filter(item => !view.callbacks.has(item.payload.callbackId)).map(data => fact({ kind: 'callback/pending',
      sessionId: open.sessionId, data })))
  }
  private async refreshBudget(open: T.EngineOpenData, executor: T.SeatOpenExecutor): Promise<void> {
    const snapshot = await this.budget(open.sessionId), level = budgetLevel(snapshot)
    if (level !== 'warning' && level !== 'stopped') return
    const kind = level === 'warning' ? 'budget/warning' : 'budget/stopped'
    await this.journal.commit((view) => {
      const effects: T.EngineEffect[] = []
      const thresholds = kind === 'budget/stopped' ? ['budget/warning', 'budget/stopped'] as const : ['budget/warning'] as const
      for (const threshold of thresholds) {
        if (!view.decisions.some(decision => decision.effects.some(effect => effect.kind === threshold
          && effect.data.sessionId === open.sessionId && effect.data.budgetRevision === snapshot.budgetRevision))) {
          effects.push(fact({ kind: threshold, sessionId: open.sessionId, seat: snapshot.seat, data: snapshot }))
        }
      }
      return effects
    })
    const warning = this.journal.projection.decisions.flatMap(decision => decision.effects).find(effect => effect.kind === 'budget/warning'
      && effect.data.sessionId === open.sessionId && effect.data.budgetRevision === snapshot.budgetRevision)
    if (warning?.kind === 'budget/warning' && executor.notifyBudget) await executor.notifyBudget({ sessionId: open.sessionId,
      operationId: `budget:${warning.eventId}` as T.SeatOperationId, messageClass: 'handoff', mode: 'steer', budget: warning.data })
    if (level === 'stopped') await this.recordCallbacks(open, 'budget-stopped', snapshot)
  }
  private readonly recoveredOwners = new Set<T.OwnerEpoch>()
  async admitTurn(sessionId: SessionId): Promise<T.SeatTurnAdmission> {
    await this.ready()
    const open = this.journal.projection.opens.get(sessionId)
    if (!open) return { status: 'allow' }
    if (!this.journal.projection.resources.has(sessionId)) return { status: 'defer', reason: 'owner-unknown' }
    const closing = this.journal.projection.closing.get(sessionId)
    if (closing && !closing.barrierReleased) return { status: 'defer', reason: 'configuring' }
    if (open.phase !== 'active' && open.phase !== 'opening-pending') return { status: 'defer', reason: 'configuring' }
    const level = budgetLevel(await this.budget(sessionId))
    return level === 'stopped' ? { status: 'defer', reason: 'budget-stopped' }
      : level === 'unverifiable' ? { status: 'defer', reason: 'budget-unverifiable' } : { status: 'allow' }
  }
}
