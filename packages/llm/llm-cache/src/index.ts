/** Session cache policy, durable model-call accounting, and process-local admission. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { assembleContextFor } from '@panedesk/dsh-agent'
import type { Agent } from '@panedesk/dsh-agent'
import { LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@panedesk/dsh-llm'
import { renderPrompt } from '@panedesk/dsh-system-prompt'
import type { PromptAssembly } from '@panedesk/dsh-system-prompt'
import type {
  SessionLedger, LedgerCallId, LedgerRequestId, LedgerEventId, LedgerCallStart,
  LedgerCallFinish, LedgerCacheEvidence, LedgerArtifactReference, LedgerAuxiliaryFact,
} from '@panedesk/dsh-session-ledger'
import type { CachePolicy, FamilyConcurrencyLimit, KeepalivePolicy } from './types.ts'
import { FamilySemaphore } from './concurrency.ts'
import { fingerprintPrefix, orderedTools } from './fingerprint.ts'
import { resolveCachePolicy } from './policy.ts'
import type { CacheRoute } from './policy.ts'
import { cacheRemaining, foldCacheState } from './state.ts'
import type { CacheRemaining } from './types.ts'
import { scheduleKeepalive } from './keepalive.ts'
export type * from './types.ts'
export type { CacheRoute } from './policy.ts'

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
  /** Explicit capabilities for gateway routes; unknown routes never acquire guessed TTL support. */
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
    private readonly remainingFor: (agent: Agent) => Promise<CacheRemaining>) {
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
  })).default([]),
})

declare module '@panedesk/dsh-agent' {
  interface AgentOptions {
    /** Session-specific cache selection; absent children inherit their live parent's selection. */
    cachePolicy?: CachePolicy
    /** Session-specific maintenance; absent children inherit their live parent's selection. */
    cacheKeepalive?: KeepalivePolicy
  }
}

interface SessionState {
  policy: CachePolicy
  keepalive: KeepalivePolicy
  prefix?: Pick<PromptAssembly, 'sections' | 'tools'>
  evidence?: LedgerCacheEvidence | undefined
  reasons: Set<string>
  request?: GenerateOptions
  route?: string
  logicalRequestId: LedgerRequestId
  attemptIndex: number
  retryPending: boolean
  inFlight: number
  lastAttempt?: number | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  pending: Promise<void>
  failure?: unknown
  lastStart?: LedgerCallStart
  stopped: boolean
  keepaliveFailures: number
  policyOverride: boolean
  backoffMs: number
  backoffStarted?: number | undefined
  compactionTimes: number[]
  active: Set<Promise<void>>
  partial?: LedgerArtifactReference | undefined
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

function committed(result: { kind: string }): void {
  if (result.kind === 'conflict') throw new Error('Ledger rejected conflicting call evidence')
}

/** Install policy before request freezing and wrap every model stream before adapter dispatch.
 * @param ctx - plugin-owned context; optional ledger absence leaves accounting disabled.
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
      reasons: new Set(), logicalRequestId: randomUUID() as LedgerRequestId,
      attemptIndex: 0, retryPending: false, inFlight: 0, pending: Promise.resolve(), stopped: false,
      keepaliveFailures: 0, policyOverride: agent?.options.cachePolicy !== undefined || inherited?.policyOverride === true,
      backoffMs: 0, compactionTimes: [], active: new Set(),
    }
    states.set(id, state)
    return state
  }

  async function fact(service: SessionLedger, start: LedgerCallStart, value: LedgerAuxiliaryFact): Promise<void> {
    committed(await service.appendEvent({
      schemaVersion: 1, eventId: randomUUID() as LedgerEventId,
      nodeId: start.nodeId, sessionId: start.sessionId, runId: start.runId,
      callId: start.callId, observedAt: Date.now(), ...value,
    }))
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

  async function maintain(id: string, state: SessionState): Promise<void> {
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
      }
      if (agent.options.cacheKeepalive === undefined && inherited?.keepalivePolicy !== undefined) {
        state.keepalive = structuredClone(inherited.keepalivePolicy)
      }
    }
    state.compactionTimes = snapshot.rows.flatMap(row => row.kind === 'event' && row.event.kind === 'compaction' ? [row.event.committedAt] : [])
    for (const row of snapshot.rows) {
      if (row.kind === 'call' && row.start.purpose === 'conversation'
        && (state.lastStart === undefined || row.start.startedAt >= state.lastStart.startedAt)) state.lastStart = row.start
    }
    if (agent.options.cachePolicy === undefined && state.evidence?.sessionPolicy !== undefined) {
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
      resolveCachePolicy(policy, routeOf(state.request?.provider ?? agent.options.provider ?? ''), agent.id)
      state.policy = structuredClone(policy)
      state.policyOverride = true
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
  }, agent => Promise.resolve(cacheRemaining(states.get(agent.id)?.evidence, Date.now())))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined || ledger() === undefined) return assembly
    const state = stateOf(context.agent.id, context.agent)
    const available = new Set(assembly.tools.map(tool => tool.name))
    if (state.prefix === undefined) {
      state.prefix = { sections: [{ name: 'cache-stable-prefix', text: renderPrompt(assembly), interpolate: false }], tools: orderedTools(assembly.tools) }
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
    const resolved = resolveCachePolicy(policy, routeOf(request.provider), agent.id)
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
  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.id) })

  ctx.on('llm/stream', (request, next) => stream(request, next), { prepend: true })

  async function* stream(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const agent = request.sessionId === undefined ? ctx.agents.currentInitiator() : ctx.agents.get(request.sessionId)
    const id = request.sessionId ?? agent?.id ?? `auxiliary:${randomUUID()}`
    const service = ledger()
    if (service === undefined) { yield* next(); return }
    const sessionState = stateOf(id, agent)
    const auxiliary = request.purpose !== undefined && request.purpose !== 'keepalive'
    const state = auxiliary ? stateOf(`call:${randomUUID()}`, agent) : sessionState
    const completed = Promise.withResolvers<void>()
    operations.add(completed.promise)
    sessionState.active.add(completed.promise)
    try {
      await sessionState.pending
      if (sessionState.stopped || lifetime.signal.aborted) throw new Error('Cache accounting is closing')
      if (sessionState.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: sessionState.failure })
      yield* metered(request, next, id, agent, state, service)
    } finally {
      completed.resolve()
      operations.delete(completed.promise)
      sessionState.active.delete(completed.promise)
      if (state.failure !== undefined) sessionState.failure = state.failure
      if (auxiliary) for (const [key, value] of states) { if (value === state) states.delete(key) }
    }
  }

  async function* metered(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>, id: string,
    agent: Agent | undefined, state: SessionState, service: SessionLedger): AsyncGenerator<StreamChunk> {
    const callId = randomUUID() as LedgerCallId
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
      ...state.policyOverride ? { sessionPolicy: state.policy } : {}, keepalivePolicy: state.keepalive,
      keepaliveFailures: state.keepaliveFailures,
      ...state.lastAttempt === undefined ? {} : { lastKeepaliveAttemptAt: state.lastAttempt },
      ...(!changed && state.reasons.size === 0 && state.route === routeKey && state.evidence?.lastCacheEvidenceAt !== undefined
        ? { lastCacheEvidenceAt: state.evidence.lastCacheEvidenceAt } : {}),
    }
    await state.pending
    if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
    if (request.purpose === undefined && !state.retryPending) {
      state.logicalRequestId = randomUUID() as LedgerRequestId; state.attemptIndex = 0; state.backoffMs = 0
    }
    if (request.purpose === undefined) state.retryPending = false
    const startedAt = Date.now()
    const clock = performance.now()
    const sessionId = request.sessionId ?? agent?.id
    const attribution = await service.resolveCallContext({
      ...sessionId === undefined ? {} : { sessionId }, provider: request.provider, model: request.model,
    })
    const start: LedgerCallStart = {
      ...attribution.context, runId: attribution.runId, callId,
      logicalRequestId: request.purpose === undefined ? state.logicalRequestId : randomUUID() as LedgerRequestId,
      attemptIndex: request.purpose === undefined ? state.attemptIndex : 0, attemptVisibility: 'adapter',
      provider: request.provider, modelFamily: route.modelFamily, requestedModel: request.model,
      purpose: request.purpose ?? 'conversation', startedAt, cache: evidence, cacheWriteTiering: { kind: 'unknown' },
      priceVersion: attribution.priceTable?.version ?? attribution.price?.version ?? 'unknown', priceKey: attribution.price?.modelKey ?? 'unknown',
      referencePrice: true,
    }
    const signal = AbortSignal.any([lifetime.signal, ...(request.signal === undefined ? [] : [request.signal])])
    committed(await service.beginCall(start))
    if (request.purpose !== 'keepalive') state.lastStart = start
    state.inFlight += 1
    state.route = routeKey
    state.evidence = evidence
    state.reasons.clear()
    if (request.purpose === undefined) { state.request = request; state.keepaliveFailures = 0 }
    let release: (() => void) | undefined
    let admittedAt: number | undefined
    let usage: TokenUsage | undefined
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    let partial: LedgerArtifactReference | undefined
    const artifacts: LedgerArtifactReference[] = []
    let seq = 0
    let failure: unknown
    async function artifact(kind: 'partial-response' | 'keepalive-request', content: string, index: number): Promise<LedgerArtifactReference | undefined> {
      try {
        const result = await service.appendArtifact({ callId, kind, seq: index, content })
        if (result.kind === 'conflict') throw new Error('Ledger sidecar conflict')
        return result.reference
      } catch (error: unknown) {
        state.failure = error
        throw error
      }
    }
    try {
      {
        if (evidence.breakReasons.length !== 0) await fact(service, start, { kind: 'cache/break', evidence })
        if (unexplained) await fact(service, start, { kind: 'alert', alert: { code: 'unexplained-prefix-change', message: 'The stable request prefix changed without an explicit breakpoint', redacted: true } })
        if (semaphore.saturated(route.modelFamily)) await fact(service, start, { kind: 'alert', alert: { code: 'concurrency-queued', message: 'Model family admission is queued', redacted: true } })
        if (request.purpose === 'keepalive') {
          const { signal: omitted, ...snapshot } = request
          void omitted
          const reference = await artifact('keepalive-request', JSON.stringify(snapshot), 0)
          if (reference !== undefined) artifacts.push((await service.finishArtifact(reference)).reference)
        }
      }
      release = await semaphore.acquire(route.modelFamily, signal)
      signal.throwIfAborted()
      admittedAt = performance.now()
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk
        // Persist fragments before exposing them, including requests that later terminate without settlement.
        if (chunk.type !== 'finish' && chunk.type !== 'usage') partial = await artifact('partial-response', JSON.stringify(chunk), seq++)
        yield chunk
      }
    } catch (error: unknown) {
      failure = error
      throw error
    } finally {
      const settledAt = performance.now()
      release?.()
      try {
        const failed = failure !== undefined || finish === undefined || finish.reason.kind === 'error' || finish.reason.kind === 'aborted'
        if (partial !== undefined) {
          try {
            const closed = await service.finishArtifact(partial)
            artifacts.push(closed.reference)
            if (request.purpose === undefined) state.partial = failed ? closed.reference : undefined
          } catch (error: unknown) {
            state.failure = error
            await fact(service, start, { kind: 'alert', alert: { code: 'ledger-unavailable', message: 'Partial response sidecar closure failed', redacted: true } })
          }
        }
        const terminalEvidence = finish === undefined ? undefined : LlmAdapter.ledgerEvidence?.get(finish)
        if (terminalEvidence?.usageObserved === false) usage = undefined
        else if (terminalEvidence?.usage !== undefined) usage = terminalEvidence.usage
        const usageState = usage === undefined ? 'missing'
          : usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined ? 'partial' : 'complete'
        const reason = finish?.reason
        const status = finish?.httpStatus ?? (reason?.kind === 'error' || reason?.kind === 'aborted' ? reason.failure.status : undefined)
        if (finish?.cacheRetention !== undefined) {
          const retention = finish.cacheRetention
          evidence.cacheMode = retention === 'auto' ? 'automatic' : retention === 'none' ? 'disabled' : 'explicit'
          const ttlSeconds = retention === '5m' ? 300 : retention === '1h' ? 3600
            : retention === '30m' ? 1800 : retention === '12h' ? 43200 : undefined
          if (ttlSeconds === undefined) delete evidence.ttlSeconds
          else evidence.ttlSeconds = ttlSeconds
          evidence.retention = { retention, ...request.cache?.key === undefined ? {} : { key: request.cache.key } }
        }
        if (finish?.cacheDowngradeReason !== undefined) evidence.downgradeReason = finish.cacheDowngradeReason
        if ((usage?.cacheReadTokens ?? 0) > 0 || (usage?.cacheWriteTokens ?? 0) > 0) evidence.lastCacheEvidenceAt = Date.now()
        {
          const entries = attribution.priceTable?.entries ?? (attribution.price === undefined ? [] : [attribution.price])
          const responseMatches = entries.filter(entry => entry.modelKey === finish?.responseModel)
          const requestMatches = entries.filter(entry => entry.modelKey === request.model)
          const responsePrice = responseMatches.length === 1 ? responseMatches[0] : undefined
          const selectedPrice = responsePrice ?? (requestMatches.length === 1 ? requestMatches[0] : undefined)
          const priced = service.priceUsage({ usage, usageState,
            tiering: finish?.cacheWriteTiering ?? start.cacheWriteTiering, startedAt, entry: selectedPrice })
          const end: LedgerCallFinish = {
            callId, endedAt: Date.now(), observedAt: Date.now(),
            ...finish?.responseModel === undefined ? {} : { responseModel: finish.responseModel },
            responseModelReported: finish?.responseModelReported ?? 'unobservable',
            effectiveModel: finish?.responseModel ?? request.model,
            ...status === undefined ? {} : { httpStatus: status }, ...usage === undefined ? {} : { usage },
            usageState,
            ...terminalEvidence?.reportedUsage === undefined ? {} : { reportedUsage: terminalEvidence.reportedUsage },
            ...priced.costUsd === undefined ? {} : { costUsd: priced.costUsd }, pricingState: priced.state,
            priceVersion: start.priceVersion, priceKey: selectedPrice?.modelKey ?? 'unknown',
            priceKeySource: responsePrice !== undefined ? 'response-model' : selectedPrice !== undefined ? 'request-model' : 'unknown',
            wallMs: settledAt - clock, modelInFlightMs: admittedAt === undefined ? 0 : settledAt - admittedAt,
            queueMs: (admittedAt ?? settledAt) - clock, backoffMs: request.purpose === undefined ? state.backoffMs : 0, waits: [],
            // Session-to-date observations are snapshots, not additional compaction charges.
            compactionCount: state.compactionTimes.length, compactionTimes: [...state.compactionTimes], recovered: false,
            endReason: signal.aborted || reason?.kind === 'aborted' ? 'cancelled' : failed ? 'error' : 'completed',
            upstreamStopReason: reason?.kind ?? 'iterator-closed', artifacts,
            ...finish?.accountLabel === undefined ? {} : { accountLabel: finish.accountLabel },
            ...finish?.cacheWriteTiering === undefined ? {} : { cacheWriteTiering: finish.cacheWriteTiering }, cache: evidence,
            http429Count: status === 429 ? 1 : 0, http503Count: status === 503 ? 1 : 0,
            ...(usage === undefined ? {} : { peakContextTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), peakContextSource: 'usage' as const }),
          }
          const settlementClock = performance.now()
          const overdue = setTimeout(() => { ctx.logger.warn('Ledger settlement exceeded ten seconds; durable write remains in progress') }, 10_000)
          overdue.unref()
          try { committed(await service.finishCall(end)) } finally { clearTimeout(overdue) }
          if (performance.now() - settlementClock >= 10_000) {
            await fact(service, start, { kind: 'alert', alert: { code: 'ledger-settlement-delayed', message: 'Call settlement exceeded ten seconds', redacted: true } })
          }
          await fact(service, start, { kind: 'cache/evidence', evidence: structuredClone(evidence) })
          if (failed) await fact(service, start, { kind: 'alert', alert: { code: admittedAt === undefined ? 'concurrency-rejected' : 'disconnect', message: 'Model call did not complete', redacted: true } })
        }
      } catch (error: unknown) {
        state.failure = error
        ctx.logger.warn('Call settlement failed; further calls are blocked until accounting is repaired')
        if (failure !== undefined) throw new AggregateError([failure, error], 'Model call and ledger settlement failed')
        throw error
      } finally {
        state.inFlight -= 1
        arm(id, state)
        if (agent === undefined && request.sessionId === undefined) states.delete(id)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    const state = states.get(session.id)
    if (state === undefined) return
    const type: string = event.type
    if (type === 'llm/retry' || type === 'llm/retry-started') {
      state.retryPending = true
      if (type === 'llm/retry') state.backoffStarted = performance.now()
      if (type === 'llm/retry-started') {
        state.attemptIndex += 1
        if (state.backoffStarted !== undefined) state.backoffMs += performance.now() - state.backoffStarted
        state.backoffStarted = undefined
      }
      queueFact(state, { kind: 'retry', phase: type === 'llm/retry' ? 'scheduled' : 'started', logicalRequestId: state.logicalRequestId, attemptIndex: state.attemptIndex })
    }
    if (type === 'compaction/summary') {
      const committedAt = event.time
      state.compactionTimes.push(committedAt)
      queueFact(state, { kind: 'compaction', committedSeq: event.seq, committedAt })
    }
    if (type === 'compaction/summary' || type === 'image/offload' || type === 'message/prune') state.reasons.add(type)
    if (event.type === 'assistant/attempt' && state.partial !== undefined) {
      queueFact(state, { kind: 'alert', alert: { code: 'partial-attempt-linked',
        message: `Partial response belongs to assistant attempt at session sequence ${event.seq}`,
        artifact: state.partial.path, redacted: true } })
    }
    if (typeof event.surfaceOp === 'object') state.reasons.add('history-edit')
    if (event.type === 'request/header' && event.data.reason === 'change') state.reasons.add('request-config-change')
  })
  ctx.on('agent/request-error', async ({ agent, failure, retryPolicy, signal }, next) => {
    const action = await next()
    const state = states.get(agent.id)
    if (state !== undefined && action?.kind !== 'retry' && !signal.aborted) {
      const exhausted = retryPolicy?.mode === 'normal' && retryPolicy.retryableCodes.includes(failure.code)
        && (state.attemptIndex >= retryPolicy.maxRetries
          || (failure.providerRetryAfterMs ?? 0) > retryPolicy.maxDelayMs)
      if (exhausted) {
        queueFact(state, { kind: 'retry', phase: 'exhausted', logicalRequestId: state.logicalRequestId,
          attemptIndex: state.attemptIndex, ...failure.status === undefined ? {} : { httpStatus: failure.status } })
        queueFact(state, { kind: 'alert', alert: { code: 'retry-exhausted', message: 'Configured retry budget or delay limit ended recovery',
          ...state.partial === undefined ? {} : { artifact: state.partial.path }, redacted: true } })
      }
      state.retryPending = false
      await state.pending
    }
    return action
  }, { prepend: true })
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
