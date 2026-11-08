/** Cordis engine provider owns journal lifecycle, policy, recovery and resource arbitration. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { SessionLedger } from '@panedesk/dsh-session-ledger'
import { SEAT_ENGINE_NAMESPACE, SeatEngineService, type SeatService } from '@panedesk/dsh-seat'
import type * as T from '@panedesk/dsh-seat'
import { EngineJournal, EngineError, digest, decodeFrame, canonical, frame } from './journal.ts'
import { SourceRegistry } from './sources.ts'
import { TriggerRegistry, rejected, fact, reminderEffects } from './triggers.ts'
import { CallbackOutbox, isParkedAuthenticationRefusal } from './outbox.ts'
import { effectiveMode, reserveOpen } from './admission.ts'
import { externalRuleMiss, triggerRule } from './rules.ts'
import { accountUsage, budgetLevel, projectBudget } from './budget.ts'
import { queryEngine, exportEngine, verifyEngine, redactPending } from './query.ts'
import { isOpeningObservation, reconcileOpen } from './open-recovery.ts'
import { openLocalWindow } from './local-open.ts'
import { closeEffects } from './closing.ts'
import { queueReplacement, ReplacementDriver } from './replacement.ts'
import { KeepAliveScheduler, type KeepAliveRuntime } from './keepalive.ts'
import { queryTasks } from './task-query.ts'
import { freezeCallbackEvidence, type ExecutionModelReader } from './callback-evidence.ts'
import { frozenEffects, frozenIdentity, queryFrozen, recheckFrozenDefinition } from './frozen-admission.ts'
import { FrozenWriteBarrier, installFrozenBusiness } from './frozen-business.ts'
import { validChainAccepted } from './chain-storage.ts'
import { batchMemberEffects, batchMemberId, queryBatchMember } from './node-batch.ts'
import { SourceProxy } from './source-proxy.ts'
import type { SourceProxyInputs, SourceProxyPort } from './source-proxy-types.ts'
import { WakeDeliveries } from './wake-delivery.ts'
import { classifyRecheck, retentionSince, transientCategory } from './execution-recheck.ts'
import { withPreopenCallbacks } from './preopen-callback.ts'
import { preopenCancelledReason } from './frozen-terminal.ts'
import { recoverPreopenCallbacks } from './preopen-recovery.ts'
import { resolveCallback } from './callback-resolution.ts'
import { EngineFailures } from './failure.ts'
import { definitionRefusal, isDefinitionException } from './admission-definition.ts'

export type { CallbackResolveRequest, CallbackResolveResult } from '@panedesk/dsh-seat'

/** Bound unregistered or ambiguous frozen routes at the composition default; register another limit when needed. */
const PREOPEN_RETENTION_FALLBACK_MS = 900000

/** Provider options add an explicit isolated storage home to validated deployment policy. */
export interface EngineOptions { home: string; nodeId: T.SeatNodeId; config: T.SeatEngineConfig }
/** Runtime providers are resolved on use, permitting optional composition and HMR. */
export interface EngineDependencies {
  seats(): Pick<SeatService, 'resolve' | 'list' | 'close'> | undefined
  ledger(): Pick<SessionLedger, 'snapshot'> | undefined
  /** Deliver a frozen callback to its retained source owner; absence keeps routed work pending. */
  deliverCallback?: (request: T.DeliverSourceCallbackRequest, observation?: T.SeatCallbackDelivery)
  => Promise<T.SeatCallbackAttemptResult<T.DeliverSourceCallbackResult>>
  /** Omitted runtime reports unavailable cache evidence and never dispatches maintenance. */
  keepalive?: KeepAliveRuntime
}
/** All durable engine operations share one native node owner and synchronized sequence. */
export class SeatEngine extends SeatEngineService {
  /** Single durable decision owner shared by all engine operations. */
  readonly journal: EngineJournal
  /** Private wake intents share this journal's writer and recovery. */
  readonly wakeDeliveries: WakeDeliveries
  /** Registration readiness and withdrawal cover complete frozen and batch admissions. */
  readonly frozenWrites = new FrozenWriteBarrier()
  private readonly approvalAbsorption = new AsyncLocalStorage<{
    operationId: T.SeatOperationId
    items: readonly Pick<T.PendingSeatItem, 'queueItemId' | 'stateVersion'>[]
    active: boolean
  }>()
  /** Fold exact same-task reminder approvals into a human opening; acceptance owns the commit.
   * @param operationId - Opening operation the approvals belong to.
   * @param items - Same-ticket approvals observed by the scope owner.
   * @param execute - Existing opening path, including every version and scope check.
   * @returns The original opening result; a revision conflict leaves approvals untouched.
   */
  withApprovalAbsorption<R>(operationId: T.SeatOperationId,
    items: readonly Pick<T.PendingSeatItem, 'queueItemId' | 'stateVersion'>[], execute: () => Promise<R>): Promise<R> {
    const state = { operationId, items: structuredClone(items), active: true }
    return this.approvalAbsorption.run(state, execute).finally(() => { state.active = false })
  }
  private absorbedApprovals(view: import('./projection.ts').EngineProjection, input: T.SeatLocalOpenRequest): T.EngineEffect[] {
    const state = this.approvalAbsorption.getStore()
    if (!state?.active) return []
    if (state.operationId !== input.request.operationId) {
      throw new EngineError('invalid-request', 'Approval absorption belongs to another opening')
    }
    const tasks = input.openingContext?.taskIds ?? (input.request.taskId ? [input.request.taskId] : [])
    const taskId = tasks[0]
    if (tasks.length !== 1 || !taskId) throw new EngineError('invalid-request', 'Approval absorption covers one task')
    return state.items.map((expected) => {
      const item = view.pending.get(expected.queueItemId)
      if (!item || item.stateVersion !== expected.stateVersion || view.approved.has(item.queueItemId)
        || item.action !== 'open' || item.effectiveMode !== 'remind' || item.reason !== 'approval'
        || item.seat !== input.request.seat || item.projectId !== input.definition.projectId
        || item.relatedTaskIds.length !== 1 || item.relatedTaskIds[0] !== tasks[0]) {
        throw new EngineError('revision-conflict', 'Pending approval changed before absorption')
      }
      return fact({ kind: 'queue/cancelled', operationId: state.operationId, seat: item.seat,
        data: { pending: { ...item, stateVersion: item.stateVersion + 1 }, principalId: input.authority.principalId,
          previousRevision: item.stateVersion, revision: item.stateVersion + 1 } })
    })
  }
  private readonly sources = new SourceRegistry()
  private sourceProxy: SourceProxy | undefined
  /** Install one trusted source composition; disposal drains sends without owning an issuer.
   * @param port - Source owner preparation and composition-owned restricted outbox.
   * @returns Disposer that rejects new sends before draining accepted calls.
   */
  registerSourceProxy(port: SourceProxyPort): () => Promise<void> {
    if (this.sourceProxy || this.stopped) throw new EngineError('unavailable', 'Source proxy is already installed or stopping')
    const proxy = new SourceProxy(this, port)
    this.sourceProxy = proxy
    return async () => { await proxy.close(); if (this.sourceProxy === proxy) this.sourceProxy = undefined }
  }
  /** Source-only routing leaves receiver admission and unconfigured local behavior unchanged.
   * @param method - Frozen remote method.
   * @param input - Original local request.
   * @param authority - Captured local entry; trigger composition supplies its own original grant.
   * @returns Remote result or absence when no source composition is installed or target is local.
   */
  routeSource<M extends T.SeatRemoteOpeningMethod>(method: M, input: SourceProxyInputs[M], authority?: T.SeatCallContext):
  Promise<T.NodeWorkChainMethodMap[M]['result'] | undefined> {
    return this.sourceProxy?.route(method, input, authority) ?? Promise.resolve(undefined)
  }
  private readonly preopenRetentions = new Set<Readonly<{
    projectId?: T.SeatProjectId
    sourceId: T.SeatSourceId
    sourceOwnerNodeId: T.SeatNodeId
    limitMs: number
  }>>()
  /** Register a trusted composition's frozen-route retention limit before admitting work.
   * Omitting projectId covers all projects on the frozen (sourceId, sourceOwnerNodeId) route.
   * A unique exact project match takes precedence; duplicates at either level remain ambiguous.
   * @param registration - Optional project, source, original owner and explicit wall-clock limit in milliseconds.
   * @returns Disposer that withdraws permission immediately and drains the active drive.
   */
  registerPreopenRetention(registration: {
    projectId?: T.SeatProjectId
    sourceId: T.SeatSourceId
    sourceOwnerNodeId: T.SeatNodeId
    limitMs: number
  }): () => Promise<void> {
    if (this.stopped) throw new EngineError('unavailable', 'Engine is stopping')
    if (!Number.isSafeInteger(registration.limitMs) || registration.limitMs <= 0) {
      throw new EngineError('invalid-request', 'Pre-open retention limit must be positive')
    }
    const retained = Object.freeze({ ...registration })
    this.preopenRetentions.add(retained)
    return async () => { this.preopenRetentions.delete(retained); await this.activeDrive }
  }
  private retentionLimit(item: T.PendingSeatItem): number {
    return this.registeredRetentionLimit(item) ?? PREOPEN_RETENTION_FALLBACK_MS
  }
  private registeredRetentionLimit(item: T.PendingSeatItem): number | undefined {
    const route = item.frozenOpen?.nodeWorkChain?.route
    if (!route) return undefined
    const matches = [...this.preopenRetentions].filter(entry => entry.sourceId === route.sourceId
      && entry.sourceOwnerNodeId === route.sourceOwnerNodeId)
    const exact = matches.filter(entry => entry.projectId !== undefined && entry.projectId === item.projectId)
    const routeWide = matches.filter(entry => entry.projectId === undefined)
    if (exact.length > 1 || routeWide.length > 1) return undefined
    return exact[0]?.limitMs ?? routeWide[0]?.limitMs
  }
  private readonly triggers: TriggerRegistry
  private readonly outbox: CallbackOutbox
  private readonly replacements: ReplacementDriver
  private readonly keepalive: KeepAliveScheduler
  private readonly liveModelFailures = new Map<SessionId, NonNullable<T.SeatNodeStatus['openingFailures']>[number]>()
  private readonly liveDefinitionFailures = new Map<SessionId, NonNullable<T.SeatNodeStatus['openingFailures']>[number]>()
  private readonly requestModels = new Map<SessionId, { provider: string; model: string }>()
  private executor: (T.SeatOpenExecutor & { executionModel?: ExecutionModelReader }) | undefined
  private localAccess: T.SeatEngineLocalAccess | undefined
  private activeDrive: Promise<void> | undefined
  private activeCallbacks: Promise<void> | undefined
  private started: Promise<void> | undefined
  private readyAt: string | null = null
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly failures: EngineFailures
  private publishing: Promise<void> | undefined
  private readonly notificationScope = new AsyncLocalStorage<{ active: boolean }>()
  private readonly listeners = new Set<() => void>()
  constructor(ctx: Context, readonly options: EngineOptions, private readonly dependencies: EngineDependencies) {
    super(ctx)
    this.failures = new EngineFailures(options.config.failureRecovery?.retryInitialMs, (line) => {
      ctx.logger.error(line)
      console.error(line)
    }, () => { ctx.emit('seat/diagnostics-changed') }, options.config.failureRecovery?.ownerReleaseMaxAttempts,
    () => { ctx.emit('seat/diagnostics-changed') })
    this.journal = new EngineJournal(join(options.home, 'ledger/engine/v1', options.nodeId),
      options.nodeId, options.config.maxDecisionBytes)
    this.wakeDeliveries = new WakeDeliveries(this.journal,
      options.config.frozenWakeContext ? options.config.maxSourceBytes : undefined)
    ctx.provide('seatAuthorizationQueries', {
      tasks: async (request) => { await this.ready(); return queryTasks(this.journal.projection.decisions, request) },
    })
    this.triggers = new TriggerRegistry(this.journal, this.sources, options.config)
    this.outbox = new CallbackOutbox(this.journal, this.sources, options.config, dependencies.deliverCallback,
      async (delivery, parkedAt) => {
        const store: { get(name: 'nodeRouter'): { status(): Promise<readonly {
          nodeId: T.SeatNodeId
          reachable: boolean
          linkState: string
          capabilities: readonly string[]
          observedAt: string
        }[]> } | undefined } = ctx
        const router = store.get('nodeRouter')
        if (!router) return false
        const statuses = await router.status()
        return store.get('nodeRouter') === router && statuses.some(status =>
          status.nodeId === delivery.nodeWorkChain?.route.sourceOwnerNodeId && status.reachable
          && status.linkState === 'connected' && status.capabilities.includes('node-work-chain/v1')
          && Date.parse(status.observedAt) > parkedAt)
      }, options.config.failureRecovery ? (cause, observation) => {
        this.failures.record('callback-delivery', cause, undefined, observation)
      } : undefined)
    this.replacements = new ReplacementDriver(this.journal, () => this.internalSeats(), options.config.nodeName,
      deliveries => freezeCallbackEvidence(this.journal.projection, deliveries, this.executor?.executionModel))
    this.keepalive = new KeepAliveScheduler(this.journal, () => this.internalSeats(), dependencies.keepalive ?? {
      remaining: () => Promise.resolve({ kind: 'unknown' }),
      renew: () => Promise.resolve({ kind: 'rejected', reason: 'cache-evidence-unavailable' }),
    }, async sessionId => (await this.checkTurnAdmission(sessionId)).status !== 'allow')
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.stopped || !this.deferredTurns.has(agent.id)) return
      void this.drive().catch((error: unknown) => { this.failures.record('scheduled-drive', error) })
    })
    ctx.on('session/event', (session, event) => {
      const open = this.journal.projection.opens.get(session.id)
      if (open?.phase !== 'active') return
      if (event.type === 'turn/end' && event.data.reason.kind === 'completed'
        && this.liveModelFailures.delete(session.id)) ctx.emit('seat/diagnostics-changed')
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      if (this.journal.projection.opens.get(agent.id)?.phase === 'active') {
        this.requestModels.set(agent.id, { provider: config.provider, model: config.model })
      }
      return config
    }, { prepend: true })
    ctx.on('agent/error', ({ agent, error }) => {
      const open = this.journal.projection.opens.get(agent.id)
      if (this.stopped || open?.phase !== 'active' || !open.definition
        || typeof error !== 'object' || error === null || !('code' in error)
        || (error.code !== 'UNKNOWN_MODEL' && error.code !== 'session/model-unavailable')) return
      const selected = this.requestModels.get(agent.id) ?? agent.session.requestHeader()?.config
      if (!selected) return
      this.liveModelFailures.set(agent.id, { sessionId: agent.id, seat: open.definition.seat,
        agentPreset: open.definition.agentPreset, code: error.code, provider: selected.provider,
        model: selected.model, stage: 'turn' })
      ctx.emit('seat/diagnostics-changed')
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.requestModels.delete(agent.id)
      const modelChanged = this.liveModelFailures.delete(agent.id)
      const definitionChanged = this.liveDefinitionFailures.delete(agent.id)
      if (modelChanged || definitionChanged) ctx.emit('seat/diagnostics-changed')
    })
    installFrozenBusiness(ctx, this)
  }
  /** Read the outbox's live retry observations without starting a delivery.
   * @param request - Maximum observations and optional phase filter applied before the limit.
   * @returns Detached deliveries and explicit completeness, including unflushed retry counters.
   */
  override callbackObservations = async (request: { limit: number; phase?: T.SeatCallbackDelivery['phase'] }): Promise<{ items: readonly T.SeatCallbackDelivery[]; complete: boolean }> => {
    await this.ready()
    const observations = this.outbox.observations().filter(item => request.phase === undefined || item.phase === request.phase)
    return { items: observations.slice(0, request.limit), complete: observations.length <= request.limit }
  }
  /** Resolve a parked callback without replacing its payload or chain operation.
   * @param request - Callback identity, expected attempt and operator action.
   * @returns Retained state or a fixed refusal with no mutation.
   */
  override callbackResolve = async (request: T.CallbackResolveRequest): Promise<T.CallbackResolveResult> => {
    await this.ready()
    const result = await resolveCallback(this.journal, request)
    await this.publish()
    return result
  }
  async ready(): Promise<void> {
    this.started ??= this.start()
    return this.started
  }
  private async start(): Promise<void> {
    await this.journal.ready()
    if (await recoverPreopenCallbacks(this.journal, this.options.config.nodeName)) {
      this.failures.record('startup-recovery', new EngineError('state-conflict', 'Pre-open terminal evidence is ambiguous'),
        'preopen-terminal-evidence-ambiguous')
    }
    for (const resource of this.journal.projection.resources.values()) this.recoveredOwners.add(resource.owner.ownerEpoch)
    this.readyAt = new Date().toISOString()
    await this.ctx.parallel('seat/ready', await this.nodeStatus())
    this.schedule()
  }
  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.drive().then(() => { this.schedule() }, (error: unknown) => {
        this.failures.record('scheduled-drive', error); this.schedule()
      })
    }, this.options.config.ownerObserveIntervalMs)
    this.timer.unref()
  }
  async shutdown(): Promise<void> {
    const drained = this.frozenWrites.close()
    this.stopped = true
    this.failures.close()
    await Promise.all([drained, this.sourceProxy?.close()])
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
    return input.nodeWorkChain ? this.frozenWrites.run(() => this.enqueueOpen(input)) : this.enqueueOpen(input)
  }
  private enqueueOpen(input: T.SeatLocalOpenRequest): Promise<T.OpenSeatResult> {
    const result = this.localOpenChain.then(() => this.openLocal(input))
    this.localOpenChain = result.then(() => undefined, () => undefined)
    return result
  }
  /** Serialize window selection and frozen fallback with all local opening admissions.
   * @param operationId - Original wire identity retained by the callback's journal intent.
   * @param work - Local-only selection with a non-reentrant frozen opener.
   * @returns Original wake acknowledgement or admission refusal.
   */
  wakeLocal(operationId: T.SeatOperationId,
    work: (open: (input: T.SeatLocalOpenRequest) => Promise<T.OpenSeatResult>) => Promise<T.WakeSeatResult>): Promise<T.WakeSeatResult> {
    return this.frozenWrites.run(() => {
      const result = this.localOpenChain.then(async () => {
        await this.ready()
        return work(async (input) => {
          if (!input.nodeWorkChain && input.request.operationId === operationId) {
            const view = this.journal.projection
            const retained = view.decisions.some(frame => frame.effects.some(effect => effect.kind === 'trigger/accepted'
              && effect.data.trigger.evidence.kind === 'manual' && effect.data.trigger.evidence.operationId === operationId
              && effect.data.trigger.seat === input.request.seat && effect.data.trigger.kind === 'manual'))
            if (!retained && ([...view.pending.values()].some(item => item.seat === input.request.seat)
              || [...view.opens.values()].some(item => item.binding.kind === 'seat' && item.binding.seat === input.request.seat
                && !view.closed.has(item.sessionId)
                && !(item.phase === 'opening-failed' && item.failure?.effectState === 'none' && !view.resources.has(item.sessionId))))) {
              return rejected('session-busy', 'A window opening for this seat is already admitted')
            }
            return this.openLocal(input)
          }
          if (!input.nodeWorkChain || input.request.operationId !== operationId
            || input.nodeWorkChain.operationKey.method !== 'seat.wakeFrozen') {
            return rejected('unauthorized', 'Wake fallback requires its original frozen identity')
          }
          const retained = queryFrozen(this.journal.projection, {
            key: input.nodeWorkChain.operationKey, payloadDigest: input.nodeWorkChain.payloadDigest })
          if (retained.status !== 'missing') return this.openLocal(input)
          const view = this.journal.projection
          if ([...view.pending.values()].some(item => item.seat === input.request.seat)
            || [...view.opens.values()].some(item => item.binding.kind === 'seat' && item.binding.seat === input.request.seat
              && !view.closed.has(item.sessionId)
              && !(item.phase === 'opening-failed' && item.failure?.effectState === 'none' && !view.resources.has(item.sessionId)))) {
            return rejected('session-busy', 'A window opening for this seat is already admitted')
          }
          return this.openLocal(input)
        })
      })
      this.localOpenChain = result.then(() => undefined, () => undefined)
      return result
    })
  }
  private async openLocal(input: T.SeatLocalOpenRequest): Promise<T.OpenSeatResult> {
    await this.ready()
    if (input.nodeWorkChain) return this.openFrozenLocal(input)
    return openLocalWindow(this, input, async (envelope) => {
      if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
      if (this.options.config.nodeAliases[input.definition.node] !== this.options.nodeId) {
        return rejected('cross-node-unsupported', 'The seat belongs to another node')
      }
      if (this.localAccess?.preAdmit) {
        const refusal = await this.localAccess.preAdmit(input)
        if (refusal) return refusal
      }
      const frozenOpen: T.SeatFrozenOpen = { ...(this.localAccess?.requiresRecheck?.() ? { recheckRequired: true as const } : {}),
        definition: input.definition, title: input.title,
        frozenOpening: input.opening, openingMode: input.request.origin === 'manual' ? input.request.openingMode ?? 'auto' : 'auto',
        ...(input.openingContext ? { openingContext: input.openingContext } : {}) }
      const rule = input.definition.rules.find(rule => rule.enabled && rule.trigger.kind === 'manual')
      const result = await this.triggers.accept(envelope, rule?.mode, frozenOpen, (effects, view) =>
        [...this.absorbedApprovals(view, input), ...effects])
      await this.publish()
      return result
    })
  }
  private async openFrozenLocal(input: T.SeatLocalOpenRequest): Promise<T.OpenSeatResult> {
    const chain = input.nodeWorkChain
    if (!chain) return rejected('invalid-request', 'Frozen opening requires its retained chain')
    const retained = queryFrozen(this.journal.projection, { key: chain.operationKey, payloadDigest: chain.payloadDigest })
    if (retained.status === 'rejected') return retained
    if (retained.status === 'settled') {
      if (retained.method === 'seat.openFrozen') return structuredClone(retained.result)
      if (retained.method === 'seat.wakeFrozen' && retained.result.status === 'opened') return structuredClone(retained.result.result)
    }
    if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
    const definition = await this.dependencies.seats()?.resolve(input.request.seat)
    if (!definition) return rejected('unavailable', 'Seat provider is unavailable')
    if ('status' in definition) return definition
    if (this.options.config.nodeAliases[definition.node] !== this.options.nodeId || chain.route.targetNodeId !== this.options.nodeId) {
      return rejected('cross-node-unsupported', 'Frozen admission cannot route to another node')
    }
    if (!validChainAccepted(chain) || !['seat.openFrozen', 'seat.wakeFrozen'].includes(chain.operationKey.method)
      || input.request.operationId !== chain.operationKey.operationId
      || digest(input.definition) !== digest(definition) || input.opening.text !== chain.openingContext.snapshot.text
      || input.opening.digest !== chain.openingContext.snapshot.digest) {
      return rejected('invalid-request', 'Frozen local action differs from its retained wire intent')
    }
    if (this.localAccess?.preAdmit) {
      const refusal = await this.localAccess.preAdmit(input)
      if (refusal) return refusal
    }
    const originalRequest = chain.operationKey.method === 'seat.openFrozen' ? input.request
      : { seat: input.request.seat, operationId: input.request.operationId,
        ...(input.request.nodeId ? { nodeId: input.request.nodeId } : {}) }
    if (digest({ request: originalRequest, openingContext: chain.openingContext,
      expectedSeatRevision: chain.expectedSeatRevision, route: chain.route }) !== chain.payloadDigest) {
      return rejected('invalid-request', 'Derived local opening does not match its retained frozen request')
    }
    const snapshot = chain.openingContext.snapshot
    const envelope: T.TriggerEnvelope = { triggerId: digest(chain.operationKey) as string as T.TriggerId,
      sourceId: chain.route.sourceId, kind: 'manual', evidence: { kind: 'manual', origin: 'remote', operationId: input.request.operationId },
      seat: definition.seat, projectId: definition.projectId, receivedAt: new Date().toISOString(),
      data: null, dataDigest: digest(null), callbackRef: chain.route.sourceId, relatedTaskIds: snapshot.taskIds }
    const frozen: T.SeatFrozenOpen = { definition: structuredClone(definition), title: input.title,
      frozenOpening: structuredClone(input.opening), openingContext: snapshot, nodeWorkChain: chain,
      openingMode: chain.openingContext.openingMode, recheckRequired: true }
    let result: T.OpenSeatResult = rejected('unavailable', 'Frozen admission did not commit')
    try {
      await this.journal.commitAuthorization((view) => {
        const original = queryFrozen(view, { key: chain.operationKey, payloadDigest: chain.payloadDigest })
        if (original.status === 'rejected') { result = original; return [] }
        if (original.status === 'settled') {
          if (original.method === 'seat.openFrozen') result = original.result
          else if (original.method === 'seat.wakeFrozen' && original.result.status === 'opened') result = original.result.result
          return []
        }
        const resolved = this.triggers.resolveProjectPolicy(view, definition)
        const effects = frozenEffects(view, chain, envelope, frozen, undefined, undefined, resolved.policy)
        if ('status' in effects) { result = effects; return resolved.effects }
        const intent = effects.find(effect => effect.kind === 'trigger/accepted')
        if (intent?.kind !== 'trigger/accepted') throw new EngineError('invalid-request', 'Frozen intent is unavailable')
        const pending = intent.data.pending
        result = { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
          reason: pending.reason, blockedBy: pending.blockedBy }
        return [...resolved.effects, ...this.absorbedApprovals(view, input), ...effects]
      })
    } catch (error) {
      return this.frozenCommitFailure(error)
    }
    await this.publish()
    return result
  }
  /** Admit one batch member of the original explicit batch.
   * @param input - Locally frozen member action.
   * @param request - Original complete batch payload.
   * @param sourceNodeId - Authenticated sender captured by node admission.
   * @returns First committed acknowledgement or refusal; other members remain independent.
   */
  openBatchMember(input: T.SeatLocalOpenRequest, request: T.OpenSeatBatchRequest,
    sourceNodeId: T.SeatNodeId): Promise<T.OpenSeatResult> {
    return this.frozenWrites.run(() => this.openBatchMemberResolved(input, request, sourceNodeId))
  }
  private async openBatchMemberResolved(input: T.SeatLocalOpenRequest, request: T.OpenSeatBatchRequest,
    sourceNodeId: T.SeatNodeId): Promise<T.OpenSeatResult> {
    await this.ready()
    if (input.authority.nodeId !== this.options.nodeId || input.authority.origin !== request.origin
      || input.request.seat !== input.definition.seat || !request.seats.includes(input.request.seat)
      || input.request.operationId !== batchMemberId(request, sourceNodeId, input.authority.principalId, input.request.seat)) {
      return rejected('invalid-request', 'Batch member does not match its original batch')
    }
    const original = queryBatchMember(this.journal.projection, request, sourceNodeId, input.authority.principalId, input.request.seat)
    if (original) return original
    if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
    if (this.options.config.nodeAliases[input.definition.node] !== this.options.nodeId) {
      return rejected('cross-node-unsupported', 'Batch member belongs to another node')
    }
    if (this.localAccess?.preAdmit) {
      const refusal = await this.localAccess.preAdmit(input)
      if (refusal) return refusal
    }
    let result: T.OpenSeatResult = rejected('unavailable', 'Batch member did not commit')
    try {
      await this.journal.commitAuthorization((view) => {
        const retained = queryBatchMember(view, request, sourceNodeId, input.authority.principalId, input.request.seat)
        if (retained) { result = retained; return [] }
        const recheck = this.localAccess?.requiresRecheck?.() === true
        const effects = batchMemberEffects(view, input, request, sourceNodeId, input.authority.principalId, recheck)
        const intent = effects.find(effect => effect.kind === 'trigger/accepted')
        if (intent?.kind !== 'trigger/accepted') throw new EngineError('invalid-request', 'Batch member intent is unavailable')
        const pending = intent.data.pending
        result = { status: 'queued', queueItemId: pending.queueItemId, sequence: pending.sequence,
          reason: pending.reason, blockedBy: [...pending.blockedBy] }
        return [...effects]
      })
    } catch (error) { return this.frozenCommitFailure(error) }
    await this.publish()
    return result
  }
  private frozenCommitFailure(error: unknown): T.SeatRejected {
    if (!(error instanceof EngineError)) throw error
    const result = rejected(error.code, error.message)
    return error.code === 'unavailable'
      ? { ...result, error: { ...result.error, effectState: 'unknown' } } : result
  }
  registerSource(source: T.SeatTriggerSource): () => Promise<void> { return this.sources.register(source) }
  registerExecutor(executor: T.SeatOpenExecutor): () => Promise<void> {
    if (this.executor) throw new EngineError('invalid-request', 'An open executor is already registered')
    this.executor = executor
    return async () => { if (this.executor === executor) this.executor = undefined; await this.activeDrive }
  }
  async nodeStatus(): Promise<T.SeatNodeStatus> {
    const failure = this.failures.snapshot()
    const latest = new Map<T.SeatName, T.EngineOpenData>()
    for (const open of this.journal.projection.opens.values()) {
      const detail = this.journal.projection.closed.get(open.sessionId)?.detail
      if (open.definition && (open.phase === 'active'
        || detail === 'restart-manual-opening-closed' || detail === 'restart-source-wake-closed'
        || open.phase === 'opening-failed' && (open.failure?.effectState === 'none'
          || open.failure?.code === 'invalid-definition'
          || open.failure?.details && 'model' in open.failure.details))) latest.set(open.definition.seat, open)
    }
    for (const [seat, open] of latest) {
      if (open.failure?.code !== 'invalid-definition') continue
      const definition = await this.dependencies.seats()?.resolve(seat)
      if (definition && !('status' in definition) && canonical(definition) !== canonical(open.definition)) latest.delete(seat)
    }
    const openingFailures = [...latest.values()].flatMap((open) => {
      const detail = this.journal.projection.closed.get(open.sessionId)?.detail
      const restartDetail = detail === 'restart-manual-opening-closed' || detail === 'restart-source-wake-closed' ? detail : undefined
      return open.phase === 'opening-failed' && open.failure && open.definition
        ? [{ sessionId: open.sessionId, seat: open.definition.seat,
          agentPreset: open.definition.agentPreset, code: open.failure.code,
          ...(restartDetail ? { detail: restartDetail } : {}),
          ...(open.failure.details && 'model' in open.failure.details
            ? { provider: open.definition.provider, model: open.definition.model } : {}) }] : []
    })
    const liveFailures = [...this.liveModelFailures.values(), ...this.liveDefinitionFailures.values()]
    const diagnostics = [...openingFailures, ...liveFailures.filter(failure =>
      this.journal.projection.opens.get(failure.sessionId)?.phase === 'active')]
    const callbackFailures = [...this.journal.projection.callbacks.values()].filter(isParkedAuthenticationRefusal)
      .map(delivery => ({ callbackId: delivery.payload.callbackId, seat: delivery.payload.seat,
        code: delivery.lastDiagnostic?.cause.code === 'callback-authentication-failed'
          ? 'callback-authentication-failed' as const : 'unauthorized' as const }))
    return Promise.resolve({ nodeId: this.options.nodeId, nodeName: this.options.config.nodeName,
      engine: failure || this.stopped ? 'unavailable' : this.readyAt ? 'running' : 'recovering',
      openEngineWindows: [...this.journal.projection.resources.values()].reduce((sum, value) => sum + value.engineWindowUnits, 0),
      limit: this.options.config.nodeEngineWindowLimit ?? null, readyAt: this.readyAt,
      ...(failure ? { failure } : {}), ...(diagnostics.length ? { openingFailures: diagnostics } : {}),
      ...(callbackFailures.length ? { callbackFailures } : {}) })
  }
  override wakeSource = async (envelope: T.TriggerEnvelope): Promise<T.WakeSeatResult | undefined> => {
    if (envelope.evidence.kind !== 'external' || !this.options.config.sourceWake?.some(rule =>
      rule.sourceId === envelope.sourceId && rule.eventTypes.includes(envelope.evidence.kind === 'external' ? envelope.evidence.eventType : ''))) return undefined
    await this.ready()
    if (this.stopped || !this.sourceProxy) return rejected('unavailable', 'Frozen source wake routing is unavailable')
    const proxy = this.sourceProxy
    try {
      return await this.sources.use(envelope.sourceId, async (source) => {
        if (envelope.kind !== 'external' || !source.kinds.includes(envelope.kind) || envelope.callbackRef !== envelope.sourceId
          || !envelope.openingContext || !(envelope.relatedTaskIds?.length || envelope.taskId)) {
          return rejected('unauthorized', 'Source wake requires its registered event and task context')
        }
        const policy = await this.projectPolicy(envelope.projectId)
        if (!policy.modeChosen || policy.mode !== 'auto') return rejected('disabled', 'Source wake requires automatic project policy')
        const input: T.WakeSeatWithContextRequest = { seat: envelope.seat,
          operationId: `source:${envelope.sourceId}:${envelope.eventId ?? envelope.triggerId}` as T.SeatOperationId,
          openingContext: structuredClone(envelope.openingContext),
          relatedTaskIds: [...(envelope.relatedTaskIds ?? (envelope.taskId ? [envelope.taskId] : []))] }
        return await proxy.route('seat.wakeFrozen', input, undefined, envelope)
          ?? rejected('cross-node-unsupported', 'Configured source wake requires an explicit remote target')
      })
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      return rejected(error.code, error.message)
    }
  }
  async accept(envelope: T.TriggerEnvelope): Promise<T.AcceptTriggerResult> {
    await this.ready()
    if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
    if (this.sourceProxy) {
      try {
        const routed = await this.sources.use(envelope.sourceId, (source) => {
          if (!source.kinds.includes(envelope.kind) || envelope.callbackRef !== envelope.sourceId
            || envelope.evidence.kind !== envelope.kind) return Promise.resolve(rejected('unauthorized', 'Source is not authorized for this trigger'))
          return this.routeSource('engine.acceptFrozen', envelope)
        })
        if (routed !== undefined) return routed
      } catch (error) {
        if (!(error instanceof EngineError)) throw error
        return rejected(error.code, error.message)
      }
    }
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
    let frozenOpen: T.SeatFrozenOpen | T.SeatRejected
    try {
      frozenOpen = await this.sources.use(envelope.sourceId, async (source) => {
        if (!source.kinds.includes(envelope.kind) || envelope.callbackRef !== envelope.sourceId
          || envelope.evidence.kind !== envelope.kind) return rejected('unauthorized', 'Source is not authorized for this trigger')
        const retained = envelope.eventId ? [...this.journal.projection.dedup.values()].find(item =>
          item.trigger.sourceId === envelope.sourceId && item.trigger.eventId === envelope.eventId)?.pending.frozenOpen : undefined
        if (retained) return retained
        if (envelope.openingContext) return this.localAccess?.freezeContext?.(definition, { ...envelope, receivedAt })
          ?? rejected('unavailable', 'Opening context provider is unavailable')
        try {
          return await this.localAccess?.freeze(definition, { ...envelope, receivedAt }) ?? {
            definition, title: `${envelope.seat} ${new Intl.DateTimeFormat('en-US', {
              timeZone: this.ctx.get('seatGates')?.getTimeZone() ?? 'UTC', month: '2-digit', day: '2-digit',
            }).format(new Date(receivedAt)).replace('/', '-')}`, openingMode: 'auto' as const }
        } catch (error) {
          if (!isDefinitionException(error)) throw error
          return definitionRefusal(definition.seat)
        }
      })
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      frozenOpen = rejected(error.code, error.message)
    }
    if ('status' in frozenOpen) {
      const error = frozenOpen.error
      await this.journal.commit(() => [fact({ kind: 'source/rejected', seat: envelope.seat, data: {
        sourceId: envelope.sourceId, sourceEventId: envelope.eventId ?? null, digest: digest(envelope.data), error } })])
      await this.publish()
      return frozenOpen
    }
    if (this.localAccess?.requiresRecheck?.()) frozenOpen = { ...frozenOpen, recheckRequired: true }
    const rule = triggerRule(frozenOpen.definition, envelope)
    const result = await this.triggers.accept(envelope,
      externalRuleMiss(frozenOpen.definition, envelope) ? 'off' : rule?.mode, frozenOpen)
    await this.publish()
    return result
  }
  override acceptFrozen(request: T.AcceptFrozenTriggerRequest, authority: T.SeatCallContext): Promise<T.AcceptFrozenTriggerResult> {
    return this.frozenWrites.run(() => this.acceptFrozenResolved(request, authority))
  }
  private async acceptFrozenResolved(request: T.AcceptFrozenTriggerRequest,
    authority: T.SeatCallContext): Promise<T.AcceptFrozenTriggerResult> {
    await this.ready()
    const input = frozenIdentity(request, authority, 'engine.acceptFrozen')
    if ('status' in input) return input
    const retained = queryFrozen(this.journal.projection, { key: input.operationKey, payloadDigest: input.payloadDigest })
    if (retained.status === 'rejected') return retained
    if (retained.status === 'settled' && retained.method === 'engine.acceptFrozen') return structuredClone(retained.result)
    if (this.stopped) return rejected('unavailable', 'Engine is shutting down')
    if (!validChainAccepted(input)) return rejected('invalid-request', 'Frozen input does not match its original business identity')
    const definition = await this.dependencies.seats()?.resolve(request.envelope.seat)
    if (!definition) return rejected('unavailable', 'Seat provider is unavailable')
    if ('status' in definition) return definition
    if (this.options.config.nodeAliases[definition.node] !== this.options.nodeId) {
      return rejected('cross-node-unsupported', 'Frozen admission cannot route to another node')
    }
    const envelope = structuredClone(request.envelope), snapshot = input.openingContext.snapshot
    if (envelope.projectId !== definition.projectId || envelope.evidence.kind !== envelope.kind
      || envelope.dataDigest !== digest(envelope.data)
      || envelope.taskId && !snapshot.taskIds.includes(envelope.taskId)
      || digest([...(envelope.relatedTaskIds ?? snapshot.taskIds)].sort()) !== digest([...snapshot.taskIds].sort())) {
      return rejected('invalid-request', 'Frozen trigger does not match target and task evidence')
    }
    if (Buffer.byteLength(canonical(request)) > this.options.config.maxSourceBytes) {
      return rejected('source-payload-too-large', 'Frozen input exceeds its byte limit')
    }
    if (envelope.cause && envelope.cause.depth >= this.options.config.maxCauseDepth) {
      return rejected('causal-depth-exceeded', 'Trigger causal chain requires manual review')
    }
    const frozen: T.SeatFrozenOpen = { definition: structuredClone(definition), title: definition.seat,
      openingMode: input.openingContext.openingMode, openingContext: snapshot, nodeWorkChain: input,
      recheckRequired: true,
      frozenOpening: { text: snapshot.text, digest: snapshot.digest,
        variables: { seat: definition.seat, date: envelope.receivedAt.slice(0, 10), taskId: envelope.taskId ?? null } } }
    let result: T.AcceptTriggerResult = rejected('unavailable', 'Frozen admission did not commit')
    try {
      await this.journal.commitAuthorization((view) => {
        const original = queryFrozen(view, { key: input.operationKey, payloadDigest: input.payloadDigest })
        if (original.status === 'rejected') { result = original; return [] }
        if (original.status === 'settled' && original.method === 'engine.acceptFrozen') { result = structuredClone(original.result); return [] }
        const resolved = this.triggers.resolveProjectPolicy(view, definition)
        const effects = frozenEffects(view, input, envelope, frozen,
          externalRuleMiss(definition, envelope) ? 'off' : triggerRule(definition, envelope)?.mode, undefined, resolved.policy)
        if ('status' in effects) { result = effects; return resolved.effects.length ? [...resolved.effects, fact({ kind: 'source/rejected',
          seat: envelope.seat, data: { sourceId: envelope.sourceId, sourceEventId: envelope.eventId ?? null,
            digest: digest(envelope.data), error: effects.error } })] : [] }
        const intent = effects.find(effect => effect.kind === 'trigger/accepted')
        if (intent?.kind !== 'trigger/accepted') throw new EngineError('invalid-request', 'Frozen intent is unavailable')
        result = { status: 'accepted', triggerId: envelope.triggerId, queueItemId: intent.data.pending.queueItemId,
          sequence: intent.data.pending.sequence }
        return [...resolved.effects, ...effects]
      })
    } catch (error) {
      return this.frozenCommitFailure(error)
    }
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
  private publish(): Promise<void> {
    if (!this.options.config.failureRecovery) return this.publishDecisions()
    // A listener's committed write must not await the notification that is awaiting that listener.
    if (this.notificationScope.getStore()?.active) return Promise.resolve()
    this.publishing ??= Promise.resolve().then(() => this.publishDecisions())
      .finally(() => { this.publishing = undefined })
    return this.publishing
  }
  private async publishDecisions(): Promise<void> {
    if (!this.failures.runnable()) return
    const supervised = !!this.options.config.failureRecovery
    do {
      const decisions = this.journal.projection.decisions.filter(decision => decision.sequence > this.published)
      if (!decisions.length) return
      for (const decision of decisions) {
        if (!supervised) this.published = decision.sequence
        for (const notify of this.listeners) notify()
        this.ctx.emit('seat/diagnostics-changed')
        const scope = { active: true }
        try {
          if (supervised) await this.notificationScope.run(scope, () => this.ctx.parallel('seat/decision', decision))
          else await this.ctx.parallel('seat/decision', decision)
        } catch (error) {
          this.failures.record('decision-notification', error)
          if (supervised) return
        } finally { scope.active = false }
        if (supervised) this.published = decision.sequence
      }
    } while (supervised && this.failures.runnable())
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
  registerProjectPolicyResolver(resolver: T.SeatProjectPolicyResolver): () => void {
    return this.triggers.registerProjectPolicyResolver(resolver)
  }
  async projectPolicy(projectId: T.SeatProjectId): Promise<T.SeatProjectPolicy> {
    await this.ready()
    return this.journal.projection.policies.get(projectId) ?? { projectId, mode: 'remind', modeChosen: false, revision: 0 }
  }
  setProjectMode(request: T.SetProjectModeRequest): Promise<T.SetProjectModeResult> {
    return this.writeProjectMode({ ...request, modeChosen: true }, false)
  }
  resetProjectMode(request: T.ResetProjectModeRequest): Promise<T.SetProjectModeResult> {
    return this.writeProjectMode(request, true)
  }
  private async writeProjectMode(request: T.ResetProjectModeRequest, reset: boolean): Promise<T.SetProjectModeResult> {
    await this.ready()
    let result: T.SetProjectModeResult = rejected('revision-conflict', 'Project policy revision changed')
    await this.journal.commit((view) => {
      const previous = view.policies.get(request.projectId) ?? { projectId: request.projectId,
        mode: 'remind', modeChosen: false, revision: 0 }
      if (previous.revision !== request.expectedRevision) return []
      const policy = { ...previous, mode: request.mode, modeChosen: request.modeChosen, revision: previous.revision + 1 }
      result = { status: 'saved', policy }
      return [fact({ kind: 'mode/changed', operationId: request.operationId, data: { policy,
        previousMode: previous.mode, previousRevision: previous.revision, principalId: 'engine-policy' as T.SeatPrincipalId,
        ...(reset ? { reset: true as const } : {}) } })]
    })
    await this.publish()
    return result
  }
  async pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult> {
    await this.ready()
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request',
      'Pending limit must be positive')
    const now = Date.now(), view = this.journal.projection
    const candidates = [...view.pending.values()].map(item => ({ item }))
    const all = candidates.filter(({ item }) => (!request.projectId || item.projectId === request.projectId)
      && (!request.seat || item.seat === request.seat) && (!request.cursor || item.sequence > request.cursor.sequence))
      .sort((a, b) => a.item.sequence - b.item.sequence)
    const page = all.slice(0, request.limit), items: T.PendingSeatObservation[] = []
    for (const { item } of page) {
      const metadata = redactPending(item)
      const source = item.sources[0], definition = item.frozenOpen?.definition
      const ruleMode = definition && source && externalRuleMiss(definition, source) ? 'off'
        : definition && source ? triggerRule(definition, source)?.mode : undefined
      const route = item.frozenOpen?.nodeWorkChain?.route
      const mode = effectiveMode(effectiveMode(view.policies.get(item.projectId)?.mode ?? 'remind', ruleMode), route?.modeCeiling.mode)
      const since = mode !== 'off' && transientCategory(item) && route && item.action === 'open'
        ? retentionSince(view, item.queueItemId) : undefined
      if (since === undefined) { items.push(metadata); continue }
      const deadline = since + this.retentionLimit(item), remainingMs = Math.max(0, deadline - now)
      items.push({ ...metadata, retention: { since, deadline, remainingMs,
        phase: remainingMs === 0 ? 'expired' : remainingMs <= 300000 ? 'expiring' : 'retained' } })
    }
    const last = page.at(-1)?.item
    return { items, complete: all.length <= request.limit, watermark: view.sequence,
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
      const effects = [fact({ kind, operationId: request.operationId, data: { pending, principalId: 'engine-policy' as T.SeatPrincipalId,
        previousRevision: previous.stateVersion, revision: pending.stateVersion } })]
      return kind === 'queue/cancelled' && previous.frozenOpen?.nodeWorkChain
        ? withPreopenCallbacks(view, effects, preopenCancelledReason(), this.options.config.nodeName) : effects
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
    if (!ledger) return { accounts: [], watermark: 0, complete: false, queryCommand: 'panedesk --profile ledger query --group-by account' }
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
    return this.replaceAction(request)
  }
  private async replaceAction(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult> {
    await this.ready()
    if (request.nodeId && request.nodeId !== this.options.nodeId) return rejected('cross-node-unsupported', 'Replacement is node-local')
    const result = await queueReplacement(this.journal, request)
    await this.publish()
    return result
  }
  async renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult> {
    return this.renewAction(request)
  }
  private async renewAction(request: T.RenewSeatRequest): Promise<T.RenewSeatResult> {
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
    if ((await this.checkTurnAdmission(request.sessionId)).status !== 'allow') return {
      ...rejected('budget-stopped', 'Maintenance is blocked by window admission'), cacheEvidence }
    let result: T.EngineKeepAliveData
    try { result = await this.keepalive.renew(request.sessionId, request.operationId, 'manual',
      evidence?.kind === 'estimated' ? evidence.evidenceAt : null, null) }
    catch (error) {
      if (!(error instanceof EngineError)) throw error
      return { ...rejected(error.code, error.message), cacheEvidence }
    }
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
    const open = this.journal.projection.opens.get(closed.sessionId)
    if (open?.phase === 'opening-failed') await this.recordCallbacks(open, 'opening-failed')
    if (!this.journal.projection.authorizationDecisions.some(frame => frame.effects.some(effect => effect.kind === 'node-route/accepted'))) {
      await this.journal.commit(view => closeEffects(view, closed, this.options.config.nodeName))
      await this.publish()
      return
    }
    const prepared = closeEffects(this.journal.projection, closed, this.options.config.nodeName)
    const deliveries = await freezeCallbackEvidence(this.journal.projection,
      prepared.flatMap(effect => effect.kind === 'callback/pending' ? [effect.data] : []), this.executor?.executionModel)
    await this.journal.commit(view => closeEffects(view, closed, this.options.config.nodeName).map((effect) => {
      if (effect.kind !== 'callback/pending') return effect
      const data = deliveries.find(item => item.payload.callbackId === effect.data.payload.callbackId)
      if (!data) throw new EngineError('state-conflict', 'Close callback changed during evidence capture')
      return { ...effect, data }
    }))
    await this.publish()
  }
  drive(): Promise<void> {
    if (this.activeDrive) return this.activeDrive.then(() => this.drive())
    this.activeDrive = this.run().finally(() => { this.activeDrive = undefined })
    return this.activeDrive
  }
  private async run(): Promise<void> {
    await this.ready()
    if (this.stopped || !this.failures.runnable()) return
    const generation = this.failures.generation()
    await this.checkPreopenRetention()
    if (!this.failures.runnable()) return
    if (this.options.config.failureRecovery) await this.publish()
    if (!this.failures.runnable()) return
    const executor = this.executor
    if (executor) {
      await this.releaseDead(executor)
      if (!this.failures.runnable()) return
      for (const item of [...this.journal.projection.pending.values()].sort((a, b) => a.sequence - b.sequence)) {
        if (!this.failures.runnable()) return
        await this.dispatch(item, executor)
      }
      // Publish each durable checkpoint before its next external Session effect.
      await this.publish()
      if (!this.failures.runnable()) return
      const recoveryExecutor: T.SeatOpenExecutor = { ...executor,
        configure: async (open, stage) => { await this.publish(); await executor.configure(open, stage) },
        opening: async (open) => { await this.publish(); return executor.opening(open) },
      }
      for (const open of [...this.journal.projection.opens.values()]) {
        if (this.deferredTurns.has(open.sessionId)) await this.readmitOwner(open, executor)
        if (!this.journal.projection.resources.has(open.sessionId)) {
          if (open.phase === 'opening-failed') await this.recordCallbacks(open, 'opening-failed')
          continue
        }
        // Later admission changes cannot block read-only observation of a durably sent opening.
        if (open.phase !== 'active' && open.phase !== 'opening-failed' && !isOpeningObservation(open)) {
          const queued = this.journal.projection.decisions.flatMap(decision => decision.effects).find(effect =>
            effect.kind === 'queue/cancelled' && canonical(effect.data.pending.sources) === canonical(open.sources))
          if (queued?.kind === 'queue/cancelled') {
            const refusal = await this.recheck(queued.data.pending)
            if (refusal) {
              if (classifyRecheck(refusal) === 'terminal' && (open.phase === 'intent' || open.phase === 'creating')
                && await executor.observe(open) === 'absent') {
                await this.journal.commit((view) => {
                  const resource = view.resources.get(open.sessionId)
                  if (!resource || view.opens.get(open.sessionId)?.phase !== open.phase) return []
                  return [fact({ kind: 'open/opening-failed', sessionId: open.sessionId,
                    data: { ...open, phase: 'opening-failed', failure: refusal.error } }),
                  fact({ kind: 'resource/released', sessionId: open.sessionId, data: { owner: resource.owner,
                    reason: 'open-aborted', observedAt: new Date().toISOString(), releasedAt: new Date().toISOString(),
                    engineReadyAt: this.readyAt, fenced: true } })]
                })
              }
              continue
            }
          }
        }
        let recovered: T.EngineOpenData
        try {
          const retryModel = this.modelReadmissions.delete(open.sessionId)
          recovered = await reconcileOpen(this.journal, open, recoveryExecutor, current => this.callbacks(current, 'opened'),
            this.options.config.failureRecovery ? async () => { await this.publish(); return this.failures.runnable() } : undefined,
            retryModel)
        }
        catch (error) {
          const replacement = [...this.journal.projection.replacements.values()].find(item => item.newSessionId === open.sessionId)
          if (!replacement || !(error instanceof EngineError) || !['open-create-failed', 'open-configuration-failed'].includes(error.code)) throw error
          recovered = { ...open, phase: 'opening-failed', failure: rejected('replacement-open-failed', 'Replacement creation failed').error }
          await this.journal.commit(() => [fact({ kind: 'open/opening-failed', sessionId: open.sessionId, data: recovered })])
        }
        if (!this.failures.runnable()) return
        if (recovered.phase === 'opening-failed') await this.recordCallbacks(recovered, 'opening-failed')
        await this.refreshBudget(recovered, executor)
      }
      await this.replacements.drive(executor)
    }
    await this.keepalive.drive()
    this.activeCallbacks ??= this.outbox.deliver().then(() => this.publish())
      .catch((error: unknown) => { this.failures.record('callback-delivery', error) }).finally(() => { this.activeCallbacks = undefined })
    if (this.options.config.failureRecovery) await this.activeCallbacks
    await this.publish()
    if (!this.outbox.hasFailedDelivery()) this.failures.succeeded(generation)
    if (this.failures.runnable()) {
      for (const id of [...this.deferredTurns]) {
        const agent = this.ctx.get('agents')?.get(id)
        if (!agent) { this.deferredTurns.delete(id); continue }
        if (agent.status === 'idle' && (await this.checkTurnAdmission(id)).status === 'allow') {
          this.deferredTurns.delete(id)
          agent.wake?.()
        }
      }
    }
  }
  private async checkPreopenRetention(): Promise<void> {
    for (const item of [...this.journal.projection.pending.values()]) {
      if (!item.frozenOpen?.nodeWorkChain || item.action !== 'open') continue
      await this.journal.commit((view) => {
        const current = view.pending.get(item.queueItemId)
        if (!current?.frozenOpen?.nodeWorkChain || canonical(current) !== canonical(item)) return []
        const route = current.frozenOpen.nodeWorkChain.route
        const source = current.sources[0], definition = current.frozenOpen.definition
        const ruleMode = source && externalRuleMiss(definition, source) ? 'off'
          : source ? triggerRule(definition, source)?.mode : undefined
        const mode = effectiveMode(effectiveMode(view.policies.get(current.projectId)?.mode ?? 'remind', ruleMode), route.modeCeiling.mode)
        if (mode === 'off') return []
        const limit = this.retentionLimit(current)
        if (!transientCategory(current) && current.reason !== 'provider-unavailable') return []
        if (!this.executor || !this.localAccess?.recheck) {
          if (!transientCategory(current)) {
            return [fact({ kind: 'queue/pending', seat: current.seat, data: { ...current,
              reason: 'provider-unavailable', blockedBy: ['provider-unavailable'], stateVersion: current.stateVersion + 1 } })]
          }
        }
        if (!transientCategory(current)) return []
        const since = retentionSince(view, current.queueItemId)
        if (since === undefined || Date.now() - since < limit) return []
        const error: T.SeatFailure = { code: 'gate-denied', message: 'Pre-open retention limit reached',
          alternative: 'Query the original operation; prepare and submit a new operation.', retryable: false, effectState: 'none' }
        return withPreopenCallbacks(view, [fact({ kind: 'open/rejected', seat: current.seat, data: { error, candidates: [] } }),
          fact({ kind: 'queue/cancelled', data: { pending: current, principalId: 'engine-policy' as T.SeatPrincipalId,
            previousRevision: current.stateVersion, revision: current.stateVersion + 1 } })], error, this.options.config.nodeName)
      })
    }
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
      if (performance.now() - start > this.options.config.ownerReleaseBudgetMs) {
        this.failures.record('owner-release',
          new EngineError('unavailable', 'Owner release exceeded its configured time budget'), 'owner-release-budget-exceeded')
        return
      }
    }
  }
  private async recheckFrozenTarget(item: T.PendingSeatItem): Promise<T.SeatRejected | null> {
    const chain = item.frozenOpen?.nodeWorkChain
    if (!chain) return null
    const definition = await this.dependencies.seats()?.resolve(item.seat)
    if (!definition) throw new EngineError('unavailable', 'Seat provider is unavailable')
    if ('status' in definition) return definition
    if (this.options.config.nodeAliases[definition.node] !== this.options.nodeId || chain.route.targetNodeId !== this.options.nodeId) {
      return rejected('cross-node-unsupported', 'Frozen admission cannot route to another node')
    }
    return recheckFrozenDefinition(chain, definition)
  }
  private async recheck(item: T.PendingSeatItem): Promise<T.SeatRejected | null> {
    const access = this.localAccess
    try {
      const refusal = await this.recheckFrozenTarget(item)
      if (refusal) return refusal
      if (access?.recheck) {
        const result = await access.recheck(structuredClone(item))
        if (this.localAccess === access) {
          if (result) return result
          const targetRefusal = await this.recheckFrozenTarget(item)
          if (this.localAccess === access) return targetRefusal
        }
      } else if (!item.frozenOpen?.recheckRequired) return null
    } catch (_error) { /* An unavailable execution policy cannot grant permission. */ }
    return { status: 'rejected', error: { code: 'unavailable', message: 'Execution permission is unconfirmed.',
      alternative: 'Restore the execution policy and recheck.', retryable: true, effectState: 'unknown' } }
  }
  private async dispatch(item: T.PendingSeatItem, executor: T.SeatOpenExecutor): Promise<void> {
    const definition = item.frozenOpen?.definition ?? await this.dependencies.seats()?.resolve(item.seat)
    if (!definition || 'status' in definition) return
    const source = item.sources[0]
    const rule = source ? triggerRule(definition, source) : undefined
    const chain = item.frozenOpen?.nodeWorkChain
    const manual = item.triggerKind === 'manual' && (!chain || chain.operationKey.method !== 'engine.acceptFrozen')
    const livePolicy = manual ? undefined : await this.dependencies.seats()?.resolve(item.seat)
    const currentDefinition = livePolicy && !('status' in livePolicy) ? livePolicy : definition
    const ruleMode = source && externalRuleMiss(currentDefinition, source) ? 'off'
      : source ? triggerRule(currentDefinition, source)?.mode : rule?.mode
    const sessionId = randomUUID() as SessionId
    const budget = await this.readBudget(sessionId, item.seat, {
      ...(rule?.windowBudgetUsd !== undefined ? { windowBudgetUsd: rule.windowBudgetUsd } : {}),
      ...(rule?.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: rule.dailyBudgetUsd } : {}) })
    const refusal = item.action === 'wake-sender' ? null : await this.recheck(item)
    const action = { wake: false }
    await this.journal.commit((view) => {
      const current = view.pending.get(item.queueItemId)
      if (!current || canonical(current) !== canonical(item)) return []
      const policy = view.policies.get(item.projectId)
      const localMode = manual ? 'auto' : effectiveMode(policy?.mode ?? 'remind', ruleMode)
      const mode = chain && !manual ? effectiveMode(localMode, chain.route.modeCeiling.mode) : localMode
      const pending = (reason: T.PendingReason, blockedBy: readonly string[] = []): T.EngineEffect[] => {
        if (current.reason === reason && current.effectiveMode === mode && canonical(current.blockedBy) === canonical(blockedBy)) return []
        const next = { ...current, effectiveMode: mode, reason, blockedBy, stateVersion: current.stateVersion + 1 }
        return [fact({ kind: 'queue/pending', seat: item.seat, data: next }), ...reminderEffects(next, current)]
      }
      if (item.frozenOpen?.nodeWorkChain && mode === 'off') return pending('project-off')
      if (refusal) {
        const classification = classifyRecheck(refusal)
        if (classification !== 'terminal') return pending('provider-unavailable', [classification])
        return withPreopenCallbacks(view, [fact({ kind: 'open/rejected', seat: item.seat, data: { error: refusal.error, candidates: [] } }),
          fact({ kind: 'queue/cancelled', data: { pending: current, principalId: 'engine-policy' as T.SeatPrincipalId,
            previousRevision: current.stateVersion, revision: current.stateVersion + 1 } })], refusal.error, this.options.config.nodeName)
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
      if (admission.status === 'rejected') {
        const error = rejected(admission.code, 'Window admission refused').error
        return withPreopenCallbacks(view, [fact({ kind: 'open/rejected', seat: item.seat, data: { error, candidates: [] } }),
          fact({ kind: 'queue/cancelled', data: { pending: current, principalId: 'engine-policy' as T.SeatPrincipalId,
            previousRevision: current.stateVersion, revision: current.stateVersion + 1 } })], error, this.options.config.nodeName)
      }
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
  private async callbacks(open: T.EngineOpenData, kind: 'opened' | 'opening-failed' | 'budget-stopped',
    snapshot = open.budget): Promise<T.SeatCallbackDelivery[]> {
    if (open.binding.kind !== 'seat') return []
    const binding = open.binding
    const deliveries: T.SeatCallbackDelivery[] = (open.sources ?? []).map((source) => {
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
    return freezeCallbackEvidence(this.journal.projection, deliveries, this.executor?.executionModel)
  }
  private async recordCallbacks(open: T.EngineOpenData, kind: 'opening-failed' | 'budget-stopped', snapshot = open.budget): Promise<void> {
    const callbacks = await this.callbacks(open, kind, snapshot)
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
  private async readmitOwner(open: T.EngineOpenData, executor: T.SeatOpenExecutor): Promise<void> {
    const view = this.journal.projection, sessionId = open.sessionId
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (!agent || view.resources.has(sessionId) || view.closed.has(sessionId) || view.closing.has(sessionId)
      || !open.definition || open.phase !== 'active' || this.stopped || !this.failures.runnable()) return
    const effects = view.decisions.flatMap(decision => decision.effects)
    const released = effects.findLast(effect => effect.kind === 'resource/released' && effect.data.owner.sessionId === sessionId)
    if (released?.kind !== 'resource/released'
      || !['holder-death', 'host-restart-recovery'].includes(released.data.reason)) return
    const retained = effects.findLast(effect => effect.kind === 'resource/reserved'
      && effect.data.owner.ownerEpoch === released.data.owner.ownerEpoch)
    if (retained?.kind !== 'resource/reserved' || retained.data.owner.intentId !== open.intentId
      || !view.fenced.has(retained.data.owner.ownerEpoch) || await executor.observe(open) !== 'matching') return
    const owner: T.ResourceOwner = { sessionId, intentId: open.intentId, ownerEpoch: randomUUID() as T.OwnerEpoch,
      resourceRevision: retained.data.owner.resourceRevision + 1 }
    if (await executor.owner(owner) !== 'alive') return
    const budget = await this.budget(sessionId)
    await this.journal.commit((current) => {
      if (this.stopped || !this.failures.runnable() || this.ctx.get('agents')?.get(sessionId) !== agent
        || current.resources.has(sessionId) || current.closed.has(sessionId) || current.closing.has(sessionId)
        || current.opens.get(sessionId) !== open || !current.fenced.has(retained.data.owner.ownerEpoch)
        || current.budgets.get(sessionId)?.budgetRevision !== budget.budgetRevision) return []
      const source = open.sources?.[0], definition = open.definition
      if (!definition) return []
      const rule = source ? triggerRule(definition, source) : undefined
      const nodeLimit = this.options.config.nodeEngineWindowLimit
      const admission = reserveOpen({ projection: current, definition,
        ...(rule ? { rule } : {}), nodeId: this.options.nodeId,
        aliases: this.options.config.nodeAliases, engine: retained.data.engineWindowUnits > 0,
        now: Date.now(), ...(nodeLimit !== undefined ? { nodeLimit } : {}), budget, sessionId })
      if (admission.status !== 'allowed' || [...current.resources.values()].some(resource =>
        resource.exclusiveTags.some(tag => retained.data.exclusiveTags.includes(tag)))) return []
      return [fact({ kind: 'resource/reserved', sessionId, seat: retained.data.seat,
        data: { ...retained.data, owner } })]
    })
  }
  private readonly recoveredOwners = new Set<T.OwnerEpoch>()
  private readonly deferredTurns = new Set<SessionId>()
  private readonly modelReadmissions = new Set<SessionId>()
  /** Check this window before input claim; only explicit no-effect configuration refusals stay local.
   * @param sessionId - Window requesting a model turn.
   * @param site - Actual query entry, retained in supervised exception diagnostics.
   * @returns Allow or defer without consuming queued input.
   */
  async admitTurn(sessionId: SessionId, site: 'turn-admission' | 'agent/turn-admitting'
    | 'seat-local/list' | 'seat-local/wake' = 'turn-admission'): Promise<T.SeatTurnAdmission> {
    await this.ready()
    const open = this.journal.projection.opens.get(sessionId)
    if (!this.stopped && this.failures.runnable() && open?.phase === 'opening-failed'
      && open.failure?.details && 'model' in open.failure.details) {
      this.modelReadmissions.add(sessionId)
      await this.drive()
    }
    let admission: T.SeatTurnAdmission
    try { admission = await this.checkTurnAdmission(sessionId) }
    catch (error) {
      if (!this.stopped && this.options.config.failureRecovery) {
        this.failures.record(site, error)
        // A failed query leaves input unclaimed; recovery must retain its original wake.
        if (this.failures.snapshot()?.retryable) this.deferredTurns.add(sessionId)
      }
      throw error
    }
    if (admission.status === 'defer') this.deferredTurns.add(sessionId)
    return admission
  }
  private async checkTurnAdmission(sessionId: SessionId): Promise<T.SeatTurnAdmission> {
    await this.ready()
    const open = this.journal.projection.opens.get(sessionId)
    if (!open) return { status: 'allow' }
    if (!this.journal.projection.resources.has(sessionId)) return { status: 'defer', reason: 'owner-unknown' }
    const closing = this.journal.projection.closing.get(sessionId)
    if (closing && !closing.barrierReleased) return { status: 'defer', reason: 'configuring' }
    if (open.phase !== 'active' && open.phase !== 'opening-pending') return { status: 'defer', reason: 'configuring' }
    const level = budgetLevel(await this.budget(sessionId))
    const definition = open.definition ? await this.dependencies.seats()?.resolve(open.definition.seat) : undefined
    if (definition && 'status' in definition && definition.error.code === 'invalid-definition'
      && !definition.error.retryable && definition.error.effectState === 'none' && open.definition) {
      if (!this.liveDefinitionFailures.has(sessionId)) {
        this.liveDefinitionFailures.set(sessionId, { sessionId, seat: open.definition.seat,
          agentPreset: open.definition.agentPreset, code: 'invalid-definition', stage: 'turn' })
        this.ctx.emit('seat/diagnostics-changed')
      }
      return { status: 'defer', reason: 'configuring' }
    }
    if (open.definition && !definition) throw new EngineError('unavailable', 'Seat definition provider is unavailable')
    if (definition && 'status' in definition) throw new EngineError(definition.error.code, 'Seat definition admission is unconfirmed')
    if (this.liveDefinitionFailures.delete(sessionId)) this.ctx.emit('seat/diagnostics-changed')
    return level === 'stopped' ? { status: 'defer', reason: 'budget-stopped' }
      : level === 'unverifiable' ? { status: 'defer', reason: 'budget-unverifiable' } : { status: 'allow' }
  }
}
