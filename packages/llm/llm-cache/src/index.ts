/** Session cache policy, call evidence contributions, and process-local admission. */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { assembleContextFor } from '@panedesk/dsh-agent'
import type { Agent } from '@panedesk/dsh-agent'
import type { GenerateOptions } from '@panedesk/dsh-llm'
import { renderPrompt } from '@panedesk/dsh-system-prompt'
import type { PromptAssembly } from '@panedesk/dsh-system-prompt'
import type {
  SessionLedger, LedgerEventId, LedgerCallStart, LedgerCacheEvidence, LedgerAuxiliaryFact,
  CallContributor, CallContributionScope,
} from '@panedesk/dsh-session-ledger'
import type { CachePolicy, FamilyConcurrencyLimit, KeepalivePolicy, ResolvedCachePolicy } from './types.ts'
import { FamilySemaphore } from './concurrency.ts'
import { fingerprintPrefix, orderedTools } from './fingerprint.ts'
import { resolveCachePolicy, validateCachePolicySelection } from './policy.ts'
import type { CacheRoute } from './policy.ts'
import { cacheRemaining, foldCacheState } from './state.ts'
import type { CacheRemaining, CacheRenewRequest, CacheRenewResult } from './types.ts'
import { scheduleKeepalive } from './keepalive.ts'
import { CacheViewService } from './cache-view.ts'
export { CacheViewService } from './cache-view.ts'
export type * from './view-types.ts'
export type * from './types.ts'
export type { CacheRoute, RouteRetention } from './policy.ts'

/** Loader plugin identity. */
export const name = 'llm-cache'
/** Without the optional ledger, preserve upstream request and admission behavior. */
export const inject = ['llm', 'agents', 'systemPrompt']
/** Session cache and harness-process concurrency configuration. */
export interface Config {
  /** Default session cache retention and stable key policy. */
  policy: CachePolicy
  /** Default maintenance scheduling policy for idle sessions. */
  keepalive: KeepalivePolicy
  /** Admission limits for explicitly configured provider families. */
  concurrency: FamilyConcurrencyLimit[]
  /** Explicit gateway-route capabilities with optional per-route `default` retention;
   * explicit session selections win and unknown routes never acquire guessed TTL support. */
  routes?: CacheRoute[]
  /** Consecutive failed refreshes before maintenance pauses until a new ordinary call or explicit update. */
  keepaliveFailureBudget?: number
}

declare module '@panedesk/cordis' {
  interface Context {
    llmCache: CacheService
  }
}

/** Live cache policy and evidence queries owned by the cache plugin. */
export class CacheService extends Service {
  constructor(ctx: Context,
    private readonly updateSession: (update: { agent: Agent; policy?: CachePolicy; keepalive?: KeepalivePolicy }) => Promise<void>,
    private readonly remainingFor: (agent: Agent) => Promise<CacheRemaining>,
    private readonly routeForProvider: (provider: string) => CacheRoute,
    private readonly policyFor: (agent: Agent) => CachePolicy | undefined,
    private readonly renewSession?: (request: CacheRenewRequest) => Promise<CacheRenewResult>) {
    super(ctx, 'llmCache')
  }

  /** Update an opted-in session without rewriting its historical request headers.
   * @param update - live session and explicitly replaced settings.
   * @returns completion of pending policy evidence writes.
   */
  update(update: { agent: Agent; policy?: CachePolicy; keepalive?: KeepalivePolicy }): Promise<void> {
    return this.updateSession(update)
  }

  /** Read the evidence-based remaining estimate without dispatching a model call.
   * @param agent - session whose cache evidence is requested.
   * @returns the observed estimate, or unknown when no evidence is available.
   */
  remaining(agent: Agent): Promise<CacheRemaining> {
    return this.remainingFor(agent)
  }

  /** Read the route a provider is judged against, without changing any selection.
   * @param provider - registered provider identifier.
   * @returns the configured route, or the built-in route when configuration names none.
   */
  routeFor(provider: string): CacheRoute {
    return this.routeForProvider(provider)
  }

  /** Read the retention the next request of this session will carry, without changing it.
   * @param agent - session whose stored selection is requested.
   * @returns the selection the cache plugin holds, or undefined before that session has one.
   */
  policy(agent: Agent): CachePolicy | undefined {
    return this.policyFor(agent)
  }

  /**
   * Request at most one maintenance call under a durable operation identity.
   * @param request - live session and caller-retained operation identity.
   * @returns refusal, confirmed evidence, or uncertainty without replaying an attempted call.
   */
  renewOnce(request: CacheRenewRequest): Promise<CacheRenewResult> {
    return this.renewSession?.(request) ?? Promise.resolve({ kind: 'rejected', reason: 'cache-evidence-unavailable' })
  }
}
/** Configuration defaults never enable keepalive implicitly. */
export const Config = z.object({
  policy: z.object({
    retention: z.union(['default', 'none', '5m', '1h', '30m', '12h', 'auto']).default('default'),
    stableKey: z.string(),
  }),
  keepalive: z.object({
    enabled: z.boolean().default(false),
    leadSeconds: z.number().min(1).default(240),
    minimumIntervalSeconds: z.number().min(1).default(60),
    maxOutputTokens: z.number().min(1).default(1),
  }),
  keepaliveFailureBudget: z.number().min(1).default(3),
  concurrency: z.array(z.object({
    modelFamily: z.string().required(),
    maxInFlight: z.number().min(1).required(),
  })).default([]),
  routes: z.array(z.object({
    provider: z.string().required(),
    modelFamily: z.string().required(),
    capability: z.union(['anthropic', 'openai-responses', 'openai-chat', 'automatic', 'unsupported']).required(),
    retention: z.union(['none', '5m', '1h', '30m', '12h', 'auto']),
  })).default([]),
})

declare module '@panedesk/dsh-agent' {
  interface AgentOptions {
    /** Session-specific cache selection; absent children inherit their live parent's selection. */
    cachePolicy?: CachePolicy
    /** SDK-provided parent selection; unsupported inherited values use the child route default. */
    cachePolicyInherited?: boolean
    /** Session-specific maintenance; absent children inherit their live parent's selection. */
    cacheKeepalive?: KeepalivePolicy
  }
}

interface SessionState {
  policy: CachePolicy
  keepalive: KeepalivePolicy
  prefix?: Pick<PromptAssembly, 'sections' | 'tools'>
  toolSdk?: string | undefined
  evidence?: LedgerCacheEvidence | undefined
  reasons: Set<string>
  request?: GenerateOptions
  route?: string
  inFlight: number
  lastAttempt?: number | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  pending: Promise<void>
  failure?: unknown
  lastStart?: LedgerCallStart
  stopped: boolean
  keepaliveFailures: number
  policyOverride: boolean
  inheritedPolicy: boolean
  inheritanceWarned: boolean
  active: Set<Promise<void>>
  downgradeReason?: string | undefined
}

function builtInRoute(provider: string): CacheRoute {
  switch (provider) {
    case 'anthropic': return { provider, modelFamily: 'anthropic', capability: 'anthropic' }
    case 'deepseek': return { provider, modelFamily: provider, capability: 'automatic' }
    default: return { provider, modelFamily: provider, capability: 'unsupported' }
  }
}

function requestSystem(request: GenerateOptions): string {
  const first = request.messages[0]
  return request.system ?? (first?.role === 'system'
    ? first.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '')
}

/** Install request policy and contribute cache evidence to the optional ledger.
 * @param ctx - plugin-owned context; optional ledger absence preserves passthrough.
 * @param config - validated policy, capability declarations, and maintenance budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const semaphore = new FamilySemaphore(config.concurrency)
  const states = new Map<string, SessionState>()
  const lifetime = new AbortController()
  const operations = new Set<Promise<void>>()
  const routes = new Map((config.routes ?? []).map(route => [route.provider, route]))
  if (routes.size !== (config.routes ?? []).length) throw new Error('Cache routes must have unique provider names')
  const routeOf = (provider: string): CacheRoute => routes.get(provider) ?? builtInRoute(provider)
  const ledger = (): SessionLedger | undefined => ctx.get('sessionLedger')

  function stateOf(id: string, agent?: Agent): SessionState {
    let state = states.get(id)
    if (state !== undefined) return state
    const parent = agent === undefined ? undefined : ctx.agents.list().find(candidate => ctx.agents.isOwnedBy(agent.id, candidate))
    const inherited = parent === undefined ? undefined : states.get(parent.id)
    state = {
      policy: structuredClone(agent?.options.cachePolicy ?? inherited?.policy ?? config.policy),
      keepalive: structuredClone(agent?.options.cacheKeepalive ?? inherited?.keepalive ?? config.keepalive),
      reasons: new Set(), inFlight: 0, pending: Promise.resolve(), stopped: false,
      keepaliveFailures: 0, policyOverride: agent?.options.cachePolicy !== undefined || inherited !== undefined,
      inheritedPolicy: agent?.options.cachePolicyInherited === true
        || (agent?.options.cachePolicy === undefined && parent !== undefined),
      inheritanceWarned: false,
      active: new Set(),
    }
    states.set(id, state)
    return state
  }

  async function fact(service: SessionLedger, start: LedgerCallStart, value: LedgerAuxiliaryFact): Promise<void> {
    const result = await service.appendEvent({
      ...value, schemaVersion: 1, eventId: randomUUID() as LedgerEventId,
      nodeId: start.nodeId, sessionId: start.sessionId, runId: start.runId,
      callId: start.callId, observedAt: Date.now(),
    })
    if (result.kind === 'conflict') throw new Error('Ledger rejected conflicting call evidence')
  }

  function queueFact(state: SessionState, value: LedgerAuxiliaryFact): void {
    const service = ledger()
    const start = state.lastStart
    if (service === undefined || start === undefined) return
    state.pending = state.pending.then(() => fact(service, start, value)).catch((error: unknown) => {
      state.failure = error
      ctx.logger.warn('Cache ledger observation failed; further calls are blocked')
    })
  }

  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.id) })

  function arm(id: string, state: SessionState): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    if (state.stopped || lifetime.signal.aborted || ledger() === undefined || state.request === undefined
      || state.keepaliveFailures >= (config.keepaliveFailureBudget ?? 3)) return
    const due = scheduleKeepalive(state.evidence, state.keepalive, Date.now(), state.lastAttempt)
    if (due === undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      const operation = maintain(id, state).finally(() => operations.delete(operation))
      operations.add(operation)
    }, Math.max(0, due - Date.now()))
    state.timer.unref()
  }

  async function maintain(id: string, state: SessionState, beforeDispatch?: () => Promise<boolean>): Promise<void> {
    state.lastAttempt = Date.now()
    const agent = ctx.agents.list().find(candidate => candidate.id === id)
    const request = state.request
    if (agent === undefined || request === undefined || state.stopped) return
    if (agent.status !== 'idle' || state.inFlight !== 0 || state.active.size !== 0 || semaphore.saturated(routeOf(request.provider).modelFamily)) {
      queueFact(state, { kind: 'alert', alert: { code: 'keepalive-skipped-busy', message: 'Idle refresh deferred because work is active', redacted: true } })
      await state.pending
      arm(id, state)
      return
    }
    const reservation = { entered: false }
    try {
      const priorEvidenceAt = state.evidence?.lastCacheEvidenceAt
      await agent.runMaintenance(async (signal) => {
        reservation.entered = true
        const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
        const tools = state.prefix?.tools ?? assembly.tools
        if (fingerprintPrefix(requestSystem(request), tools) !== state.evidence?.prefixFingerprint) {
          queueFact(state, { kind: 'alert', alert: { code: 'keepalive-prefix-changed', message: 'Refresh skipped until an ordinary call records changed tool permissions', redacted: true } })
          state.evidence = undefined
          return
        }
        if (beforeDispatch !== undefined && !await beforeDispatch()) return
        const refresh: GenerateOptions = {
          provider: request.provider, model: request.model,
          system: requestSystem(request), tools: structuredClone(tools),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }],
          cache: resolveCachePolicy(state.policyOverride ? state.policy : request.cache === undefined ? state.policy
            : { retention: request.cache.retention,
              ...request.cache.key === undefined ? {} : { stableKey: request.cache.key } }, routeOf(request.provider), id).control,
          sessionId: agent.id, purpose: 'keepalive',
          maxTokens: state.keepalive.maxOutputTokens,
          signal: AbortSignal.any([signal, lifetime.signal]),
        }
        for await (const chunk of ctx.llm.stream(refresh)) {
          if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            ctx.logger.warn('Cache keepalive did not complete; retention evidence was not refreshed')
          }
        }
      })
      state.keepaliveFailures = state.evidence?.lastCacheEvidenceAt !== priorEvidenceAt ? 0 : state.keepaliveFailures + 1
    } catch (error: unknown) {
      if (!reservation.entered) {
        queueFact(state, { kind: 'alert', alert: { code: 'keepalive-skipped-busy', message: 'Maintenance reservation was unavailable', redacted: true } })
        return
      }
      state.keepaliveFailures += 1
      ctx.logger.warn('Cache keepalive failed; maintenance has a finite failure budget')
      if (state.failure === undefined && lifetime.signal.aborted) return
      void error
    } finally {
      if (state.keepaliveFailures >= (config.keepaliveFailureBudget ?? 3)) {
        queueFact(state, { kind: 'alert', alert: { code: 'keepalive-budget-exhausted', message: 'Maintenance paused after consecutive unconfirmed refreshes', redacted: true } })
      }
      if (state.evidence !== undefined) {
        state.evidence.keepaliveFailures = state.keepaliveFailures
        state.evidence.lastKeepaliveAttemptAt = state.lastAttempt
        queueFact(state, { kind: 'cache/evidence', evidence: structuredClone(state.evidence) })
      }
      await state.pending
      arm(id, state)
    }
  }

  const renewals = new Map<string, Promise<CacheRenewResult>>()
  function renewOnce(request: CacheRenewRequest): Promise<CacheRenewResult> {
    const key = JSON.stringify([request.sessionId, request.operationId])
    const existing = renewals.get(key)
    if (existing !== undefined) return existing
    const operation = renew(request).finally(() => { renewals.delete(key) })
    renewals.set(key, operation)
    const settled = operation.then(() => {}, () => {}).finally(() => { operations.delete(settled) })
    operations.add(settled)
    return operation
  }

  async function renew(request: CacheRenewRequest): Promise<CacheRenewResult> {
    const agent = ctx.agents.get(request.sessionId)
    if (agent === undefined) return { kind: 'rejected', reason: 'session-unavailable' }
    const state = states.get(agent.id)
    if (state === undefined || state.request === undefined || state.stopped) return { kind: 'rejected', reason: 'cache-evidence-unavailable' }
    const service = ledger()
    if (service === undefined || state.failure !== undefined) return { kind: 'rejected', reason: 'ledger-unavailable' }
    const eligible = (): CacheRenewResult | undefined => {
      if (agent.status !== 'idle' || state.inFlight !== 0 || state.active.size !== 0) return { kind: 'rejected', reason: 'busy' }
      const remaining = cacheRemaining(state.evidence, Date.now())
      if (remaining.kind !== 'estimated' || remaining.evidenceAt > Date.now()) return { kind: 'rejected', reason: 'cache-evidence-unavailable' }
      if (remaining.seconds <= 0) return { kind: 'rejected', reason: 'cache-expired' }
      if (state.reasons.size !== 0) return { kind: 'rejected', reason: 'prefix-changed' }
      return undefined
    }
    const rejected = eligible()
    if (rejected !== undefined) return rejected
    const eventId = `cache-renew:${createHash('sha256').update(JSON.stringify([request.sessionId, request.operationId])).digest('hex')}` as LedgerEventId
    const snapshot = await service.snapshot({ sessionId: request.sessionId })
    if (!snapshot.complete) return { kind: 'rejected', reason: 'ledger-unavailable' }
    if (snapshot.rows.some(row => row.kind === 'event' && row.event.eventId === eventId)) return { kind: 'uncertain', reason: 'prior-attempt' }
    const start = state.lastStart
    if (start === undefined) return { kind: 'rejected', reason: 'cache-evidence-unavailable' }
    const attempt: { refusal?: CacheRenewResult; dispatched: boolean } = { dispatched: false }
    const previousEvidence = state.evidence?.lastCacheEvidenceAt
    await maintain(agent.id, state, async () => {
      // runMaintenance owns the idle phase while this durable claim is committed.
      const refusal = eligible()
      if (refusal !== undefined) { attempt.refusal = refusal; return false }
      // A failed acknowledgement cannot establish whether the durable claim committed.
      attempt.refusal = { kind: 'uncertain', reason: 'prior-attempt' }
      const claim = await service.appendEvent({ schemaVersion: 1, eventId, nodeId: start.nodeId,
        sessionId: request.sessionId, runId: start.runId, observedAt: Date.now(), kind: 'alert',
        alert: { code: 'cache-renew-once-attempt', message: 'Explicit cache maintenance attempt reserved', redacted: true } })
      if (claim.kind !== 'appended') return false
      delete attempt.refusal
      attempt.dispatched = true
      return true
    })
    if (attempt.refusal !== undefined) return attempt.refusal
    if (!attempt.dispatched) return { kind: 'rejected', reason: state.evidence === undefined ? 'prefix-changed' : 'busy' }
    const current = states.get(agent.id)
    const evidenceAt = current?.evidence?.lastCacheEvidenceAt
    return evidenceAt !== undefined && evidenceAt !== previousEvidence && current?.failure === undefined
      ? { kind: 'renewed', evidenceAt }
      : { kind: 'uncertain', reason: 'maintenance-unconfirmed' }
  }

  ctx.on('agent/created', async ({ agent }) => {
    const state = stateOf(agent.id, agent)
    const service = ledger()
    if (service === undefined) return
    const snapshot = await service.snapshot({ sessionId: agent.id })
    if (!snapshot.complete) {
      ctx.logger.warn('Cache recovery is incomplete; maintenance remains disabled until fresh evidence')
    }
    state.evidence = structuredClone(foldCacheState(snapshot))
    const linkage = service.contextFor(agent.id) ?? snapshot.rows.flatMap(row => row.kind === 'event' ? [] : [row.start])[0]
    if (state.evidence === undefined && linkage?.parentSessionId !== undefined && !states.has(linkage.parentSessionId)) {
      const parentSnapshot = await service.snapshot({ sessionId: linkage.parentSessionId })
      const inherited = parentSnapshot.complete ? foldCacheState(parentSnapshot) : undefined
      if (agent.options.cachePolicy === undefined && inherited?.sessionPolicy !== undefined) {
        state.policy = structuredClone(inherited.sessionPolicy)
        state.policyOverride = true
        state.inheritedPolicy = true
      }
      if (agent.options.cacheKeepalive === undefined && inherited?.keepalivePolicy !== undefined) {
        state.keepalive = structuredClone(inherited.keepalivePolicy)
      }
    }
    for (const row of snapshot.rows) {
      if (row.kind === 'call' && row.start.purpose === 'conversation'
        && (state.lastStart === undefined || row.start.startedAt >= state.lastStart.startedAt)) state.lastStart = row.start
    }
    if ((agent.options.cachePolicy === undefined || agent.options.cachePolicyInherited === true)
      && state.evidence?.sessionPolicy !== undefined) {
      state.policy = structuredClone(state.evidence.sessionPolicy)
      state.policyOverride = true
    }
    if (agent.options.cacheKeepalive === undefined && state.evidence?.keepalivePolicy !== undefined) {
      state.keepalive = structuredClone(state.evidence.keepalivePolicy)
    }
    state.keepaliveFailures = state.evidence?.keepaliveFailures ?? 0
    state.lastAttempt = state.evidence?.lastKeepaliveAttemptAt
    const header = agent.session.requestHeader()
    const messages = agent.session.deriveMessages()
    if (header !== undefined) {
      const request = { ...header.config, ...header.tools === undefined ? {} : { tools: header.tools },
        toolHistory: agent.session.toolHistory(), messages, sessionId: agent.id }
      state.prefix = { sections: [{ name: 'cache-stable-prefix', text: requestSystem(request), interpolate: false }], tools: orderedTools(header.tools ?? []) }
      state.route = `${request.provider}:${request.model}`
      state.request = request
      if (state.evidence?.prefixFingerprint !== fingerprintPrefix(requestSystem(request), agent.session.toolHistory().tools)) {
        state.evidence = undefined
        state.reasons.add('recovery-prefix-change')
      }
      arm(agent.id, state)
    }
    return undefined
  })
  new CacheService(ctx, async ({ agent, policy, keepalive }) => {
    const state = stateOf(agent.id, agent)
    if (policy !== undefined) {
      validateCachePolicySelection(policy)
      state.policy = structuredClone(policy)
      state.policyOverride = true
      state.inheritedPolicy = false
      state.reasons.add('cache-policy-change')
      // Old evidence describes the old tier, not the new request configuration.
      state.evidence = { ...state.evidence, cacheMode: 'unknown', breakReasons: ['cache-policy-change'], sessionPolicy: state.policy }
    }
    if (keepalive !== undefined) {
      if (keepalive.leadSeconds <= 0 || keepalive.minimumIntervalSeconds <= 0 || keepalive.maxOutputTokens <= 0) throw new Error('Invalid maintenance budget')
      state.keepalive = structuredClone(keepalive)
    }
    state.keepaliveFailures = 0
    if (state.evidence !== undefined) {
      state.evidence.keepalivePolicy = state.keepalive
      state.evidence.keepaliveFailures = 0
      queueFact(state, { kind: 'cache/evidence', evidence: structuredClone(state.evidence) })
    }
    await state.pending
    arm(agent.id, state)
  }, agent => Promise.resolve(cacheRemaining(states.get(agent.id)?.evidence, Date.now())), routeOf,
  agent => stateOf(agent.id, agent).policy, renewOnce)
  ctx.inject(['remoteAccess'], () => { ctx.plugin(CacheViewService) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined || ledger() === undefined) return assembly
    const state = stateOf(context.agent.id, context.agent)
    const available = new Set(assembly.tools.map(tool => tool.name))
    const toolSdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    // Background discovery must reach both native schemas and the PTC SDK.
    if (state.prefix === undefined || toolSdk !== state.toolSdk
      || assembly.tools.some(tool => !state.prefix?.tools.some(retained => retained.name === tool.name))) {
      if (state.prefix !== undefined) state.reasons.add('permission-change')
      state.prefix = { sections: [{ name: 'cache-stable-prefix', text: renderPrompt(assembly), interpolate: false }], tools: orderedTools(assembly.tools) }
      state.toolSdk = toolSdk
    } else {
      const retained = state.prefix.tools.filter(tool => available.has(tool.name))
      if (retained.length !== state.prefix.tools.length) {
        state.prefix = { ...state.prefix, tools: retained }
        state.reasons.add('permission-change')
      }
    }
    return { ...assembly, ...structuredClone(state.prefix) }
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next()
    if (ledger() === undefined) return request
    const state = stateOf(agent.id, agent)
    const policy = state.policyOverride || request.cache === undefined ? state.policy
      : { retention: request.cache.retention,
        ...request.cache.key === undefined ? {} : { stableKey: request.cache.key } }
    const route = routeOf(request.provider)
    let resolved: ResolvedCachePolicy
    try {
      resolved = resolveCachePolicy(policy, route, agent.id)
    } catch (error: unknown) {
      if (!state.inheritedPolicy) throw error
      const fallback: CachePolicy = { ...policy, retention: 'default' }
      resolved = resolveCachePolicy(fallback, route, agent.id)
      state.policy = fallback
      state.policyOverride = true
      if (!state.inheritanceWarned) {
        ctx.logger.warn(`Inherited cache retention ${policy.retention} is unsupported for ${route.provider} (${route.capability}); using ${resolved.control.retention}`)
        state.inheritanceWarned = true
      }
    }
    state.downgradeReason = resolved.downgradeReason
    return { ...request, cache: resolved.control }
  }, { prepend: true })
  ctx.on('agent/ending', async ({ agent }) => {
    const state = states.get(agent.id)
    if (state === undefined) return
    state.stopped = true
    if (state.timer !== undefined) clearTimeout(state.timer)
    await Promise.all([...state.active])
    await state.pending
    if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
  })

  const contributor: CallContributor = {
    async prepare({ request, id, agent, auxiliary }) {
      const sessionState = stateOf(id, agent)
      const state = auxiliary ? stateOf(`call:${randomUUID()}`, agent) : sessionState
      const completed = Promise.withResolvers<void>()
      operations.add(completed.promise)
      sessionState.active.add(completed.promise)
      let scope: CallContributionScope | undefined
      let started = false
      const dispose = (failure?: unknown) => {
        if (failure !== undefined) state.failure = failure
        if (started) state.inFlight -= 1
        completed.resolve()
        operations.delete(completed.promise)
        sessionState.active.delete(completed.promise)
        if (state.failure !== undefined) sessionState.failure = state.failure
        arm(id, state)
        if (auxiliary) for (const [key, value] of states) { if (value === state) states.delete(key) }
        if (agent === undefined && request.sessionId === undefined) states.delete(id)
      }
      try {
        await sessionState.pending
        if (sessionState.stopped || lifetime.signal.aborted) throw new Error('Cache accounting is closing')
        if (sessionState.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: sessionState.failure })
        const route = routeOf(request.provider)
        const resolution = request.cache === undefined ? { mode: 'unknown' as const, ttlSeconds: undefined, downgradeReason: undefined }
          : resolveCachePolicy({ retention: request.cache.retention,
            ...request.cache.key === undefined ? {} : { stableKey: request.cache.key } }, route, id)
        const fingerprint = fingerprintPrefix(requestSystem(request), request.toolHistory?.tools ?? request.tools ?? [])
        const routeKey = `${request.provider}:${request.model}`
        if (state.route !== undefined && state.route !== routeKey) state.reasons.add('route-change')
        const changed = state.evidence?.prefixFingerprint !== undefined && state.evidence.prefixFingerprint !== fingerprint
        const unexplained = changed && state.reasons.size === 0
        const downgradeReason = resolution.downgradeReason ?? state.downgradeReason
        const evidence: LedgerCacheEvidence = {
          prefixFingerprint: fingerprint, fingerprintVersion: 1,
          cacheEpoch: changed || state.reasons.size !== 0 ? randomUUID() : state.evidence?.cacheEpoch ?? randomUUID(),
          breakReasons: [...state.reasons], cacheMode: resolution.mode,
          ...request.cache === undefined ? {} : { retention: request.cache },
          ...resolution.ttlSeconds === undefined ? {} : { ttlSeconds: resolution.ttlSeconds },
          ...downgradeReason === undefined ? {} : { downgradeReason },
          sessionPolicy: state.policy, keepalivePolicy: state.keepalive,
          keepaliveFailures: state.keepaliveFailures,
          ...state.lastAttempt === undefined ? {} : { lastKeepaliveAttemptAt: state.lastAttempt },
          ...(!changed && state.reasons.size === 0 && state.route === routeKey && state.evidence?.lastCacheEvidenceAt !== undefined
            ? { lastCacheEvidenceAt: state.evidence.lastCacheEvidenceAt } : {}),
        }
        await state.pending
        if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
        return {
          evidence, modelFamily: route.modelFamily, signal: lifetime.signal,
          async started(value) {
            scope = value
            const { start } = value
            if (request.purpose !== 'keepalive') state.lastStart = start
            state.inFlight += 1
            started = true
            state.route = routeKey
            state.evidence = evidence
            state.reasons.clear()
            if (request.purpose === undefined) { state.request = request; state.keepaliveFailures = 0 }
            if (evidence.breakReasons.length !== 0) await value.fact({ kind: 'cache/break', evidence })
            if (unexplained) await value.fact({ kind: 'alert', alert: { code: 'unexplained-prefix-change', message: 'The stable request prefix changed without an explicit breakpoint', redacted: true } })
            if (semaphore.saturated(route.modelFamily)) await value.fact({ kind: 'alert', alert: { code: 'concurrency-queued', message: 'Model family admission is queued', redacted: true } })
            if (request.purpose === 'keepalive') {
              const { signal: omitted, ...snapshot } = request
              void omitted
              await value.artifact('keepalive-request', JSON.stringify(snapshot), 0)
            }
          },
          acquire: signal => semaphore.acquire(route.modelFamily, signal),
          terminal({ finish, terminalEvidence, usage }) {
            if (finish?.cacheRetention !== undefined) {
              const retention = finish.cacheRetention
              evidence.cacheMode = retention === 'auto' ? 'automatic' : retention === 'none' ? 'disabled' : 'explicit'
              const ttlSeconds = retention === '5m' ? 300 : retention === '1h' ? 3600
                : retention === '30m' ? 1800 : retention === '12h' ? 43200 : undefined
              if (ttlSeconds === undefined) delete evidence.ttlSeconds
              else evidence.ttlSeconds = ttlSeconds
              evidence.retention = { retention, ...request.cache?.key === undefined ? {} : { key: request.cache.key } }
            }
            if (evidence.ttlSeconds !== undefined) evidence.ttlSource = 'request-estimate'
            if (terminalEvidence?.reportedCacheRetention !== undefined) {
              evidence.reportedRetention = terminalEvidence.reportedCacheRetention
              const duration = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(evidence.reportedRetention)
              if (duration !== null) {
                const seconds = Number(duration[1]) * (duration[2] === 'd' ? 86400 : duration[2] === 'h' ? 3600 : duration[2] === 'm' ? 60 : 1)
                if (Number.isSafeInteger(seconds) && seconds > 0) {
                  evidence.ttlSeconds = seconds
                  evidence.ttlSource = 'response'
                  evidence.cacheMode = 'explicit'
                }
              }
            }
            if (finish?.cacheDowngradeReason !== undefined) evidence.downgradeReason = finish.cacheDowngradeReason
            if ((usage?.cacheReadTokens ?? 0) > 0 || (usage?.cacheWriteTokens ?? 0) > 0) evidence.lastCacheEvidenceAt = Date.now()
          },
          async interjected() {
            state.reasons.add('interjection')
            if (!evidence.breakReasons.includes('interjection')) {
              evidence.breakReasons = [...evidence.breakReasons, 'interjection']
              await scope?.fact({ kind: 'cache/break', evidence })
            }
          },
          async settled() {
            await scope?.fact({ kind: 'cache/evidence', evidence: structuredClone(evidence) })
          },
          dispose,
        }
      } catch (error: unknown) {
        dispose()
        throw error
      }
    },
  }
  ctx.inject(['sessionLedger'], (child) => {
    child.effect(() => child.sessionLedger.registerCallContributor(contributor))
  })
  ctx.on('session/event', (session, event) => {
    const state = states.get(session.id)
    if (state === undefined) return
    const type: string = event.type
    if (type === 'compaction/summary' || type === 'image/offload' || type === 'message/prune') state.reasons.add(type)
    if (typeof event.surfaceOp === 'object') state.reasons.add('history-edit')
    if (event.type === 'request/header' && event.data.reason === 'change') state.reasons.add('request-config-change')
  })
  ctx.on('agent/inbox/inserted', ({ agent }) => {
    if (agent.status === 'running') stateOf(agent.id, agent).reasons.add('interjection')
  })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Cache plugin disposed'))
    semaphore.dispose()
    for (const state of states.values()) { state.stopped = true; if (state.timer !== undefined) clearTimeout(state.timer) }
    await Promise.allSettled([...operations])
    await Promise.all([...states.values()].map(state => state.pending))
  })
}
