/** Session cache policy, durable model-call accounting, and process-local admission. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { Agent } from '@panedesk/dsh-agent'
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
import { foldCacheState } from './state.ts'
import { scheduleKeepalive } from './keepalive.ts'
export type * from './types.ts'
export type { CacheRoute } from './policy.ts'

/** Loader plugin identity. */
export const name = 'llm-cache'
/** Accounting is optional; request policy remains usable without a ledger. */
export const inject = ['llm', 'agents', 'systemPrompt']
/** Session cache and harness-process concurrency configuration. */
export interface Config {
  policy: CachePolicy
  keepalive: KeepalivePolicy
  concurrency: FamilyConcurrencyLimit[]
  /** Explicit capabilities for gateway routes; unknown routes never acquire guessed TTL support. */
  routes?: CacheRoute[]
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
  evidence?: LedgerCacheEvidence
  reasons: Set<string>
  request?: GenerateOptions
  route?: string
  logicalRequestId: LedgerRequestId
  attemptIndex: number
  retryPending: boolean
  inFlight: number
  lastAttempt?: number
  timer?: ReturnType<typeof setTimeout>
  pending: Promise<void>
  failure?: unknown
  lastStart?: LedgerCallStart
  stopped: boolean
}

function builtInRoute(provider: string): CacheRoute {
  switch (provider) {
    case 'anthropic': return { provider, modelFamily: 'anthropic', capability: 'anthropic' }
    case 'openai': return { provider, modelFamily: 'openai', capability: 'openai-responses' }
    case 'deepseek': case 'zai': case 'xai': return { provider, modelFamily: provider, capability: 'automatic' }
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
    if (state.stopped || lifetime.signal.aborted || ledger() === undefined || state.request === undefined) return
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
    try {
      if (agent.status !== 'idle' || state.inFlight !== 0 || semaphore.saturated(routeOf(request.provider).modelFamily)) return
      await agent.runMaintenance(async (signal) => {
        const refresh: GenerateOptions = {
          provider: request.provider, model: request.model,
          system: requestSystem(request), tools: structuredClone(request.toolHistory?.tools ?? request.tools ?? []),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }],
          cache: request.cache, sessionId: agent.id, purpose: 'keepalive',
          maxTokens: state.keepalive.maxOutputTokens,
          signal: AbortSignal.any([signal, lifetime.signal]),
        }
        for await (const chunk of ctx.llm.stream(refresh)) {
          if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            ctx.logger.warn('Cache keepalive did not complete; retention evidence was not refreshed')
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn('Cache keepalive failed; the next attempt remains interval-limited')
      if (state.failure === undefined && lifetime.signal.aborted) return
      void error
    } finally {
      arm(id, state)
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    const state = stateOf(agent.id, agent)
    const service = ledger()
    if (service !== undefined) state.evidence = foldCacheState(await service.snapshot({ sessionId: agent.id }))
    return undefined
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
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
    const state = stateOf(agent.id, agent)
    const policy = request.cache === undefined ? state.policy : { retention: request.cache.retention, stableKey: request.cache.key }
    const resolved = resolveCachePolicy(policy, routeOf(request.provider), agent.id)
    return { ...request, cache: resolved.control }
  }, { prepend: true })
  ctx.on('agent/ending', async ({ agent }) => {
    const state = states.get(agent.id)
    if (state === undefined) return
    state.stopped = true
    if (state.timer !== undefined) clearTimeout(state.timer)
    await state.pending
    if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
  })
  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.id) })

  ctx.on('llm/stream', (request, next) => stream(request, next), { prepend: true })

  async function* stream(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const agent = request.sessionId === undefined ? ctx.agents.currentInitiator() : ctx.agents.get(request.sessionId)
    const id = request.sessionId ?? agent?.id ?? `auxiliary:${randomUUID()}`
    const state = stateOf(id, agent)
    const service = ledger()
    const callId = randomUUID() as LedgerCallId
    const route = routeOf(request.provider)
    const resolution = resolveCachePolicy(request.cache === undefined ? state.policy : {
      retention: request.cache.retention, stableKey: request.cache.key,
    }, route, id)
    const fingerprint = fingerprintPrefix(requestSystem(request), request.toolHistory?.tools ?? request.tools ?? [])
    const routeKey = `${request.provider}:${request.model}`
    if (state.route !== undefined && state.route !== routeKey) state.reasons.add('route-change')
    const changed = state.evidence?.prefixFingerprint !== undefined && state.evidence.prefixFingerprint !== fingerprint
    const unexplained = changed && state.reasons.size === 0
    const evidence: LedgerCacheEvidence = {
      prefixFingerprint: fingerprint, fingerprintVersion: 1,
      cacheEpoch: changed ? randomUUID() : state.evidence?.cacheEpoch ?? randomUUID(),
      breakReasons: [...state.reasons], cacheMode: resolution.mode,
      retention: request.cache, ttlSeconds: resolution.ttlSeconds,
      downgradeReason: resolution.downgradeReason,
      ...(!changed && state.route === routeKey && state.evidence?.lastCacheEvidenceAt !== undefined
        ? { lastCacheEvidenceAt: state.evidence.lastCacheEvidenceAt } : {}),
    }
    await state.pending
    if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
    if (!state.retryPending) { state.logicalRequestId = randomUUID() as LedgerRequestId; state.attemptIndex = 0 }
    state.retryPending = false
    const startedAt = Date.now()
    const clock = performance.now()
    const attribution = service === undefined ? undefined : await service.resolveCallContext({
      sessionId: request.sessionId ?? agent?.id, provider: request.provider, model: request.model,
    })
    const start: LedgerCallStart | undefined = attribution === undefined ? undefined : {
      ...attribution.context, runId: attribution.runId, callId,
      logicalRequestId: state.logicalRequestId, attemptIndex: state.attemptIndex, attemptVisibility: 'adapter',
      provider: request.provider, modelFamily: route.modelFamily, requestedModel: request.model,
      purpose: request.purpose ?? 'conversation', startedAt, cache: evidence, cacheWriteTiering: { kind: 'unknown' },
      priceVersion: attribution.price?.version ?? 'unknown', priceKey: attribution.price?.modelKey ?? request.model,
      referencePrice: true,
    }
    if (service !== undefined && start !== undefined) committed(await service.beginCall(start))
    state.lastStart = start
    state.inFlight += 1
    state.route = routeKey
    state.evidence = evidence
    state.reasons.clear()
    if (request.purpose === undefined) state.request = request
    let release: (() => void) | undefined
    let admittedAt: number | undefined
    let usage: TokenUsage | undefined
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    let partial: LedgerArtifactReference | undefined
    const artifacts: LedgerArtifactReference[] = []
    let seq = 0
    let failure: unknown
    const signal = AbortSignal.any([lifetime.signal, ...(request.signal === undefined ? [] : [request.signal])])
    async function artifact(kind: 'partial-response' | 'keepalive-request', content: string, index: number): Promise<LedgerArtifactReference | undefined> {
      if (service === undefined) return
      const result = await service.appendArtifact({ callId, kind, seq: index, content })
      committed(result)
      if (result.kind === 'conflict') throw new Error('Ledger sidecar conflict')
      return result.reference
    }
    try {
      if (service !== undefined && start !== undefined) {
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
        if (service !== undefined && partial !== undefined) {
          const closed = await service.finishArtifact(partial)
          if (failed) artifacts.push(closed.reference)
        }
        const reason = finish?.reason
        const status = finish?.httpStatus ?? (reason?.kind === 'error' || reason?.kind === 'aborted' ? reason.failure.status : undefined)
        if (finish?.cacheRetention !== undefined) {
          const actual = resolveCachePolicy({ retention: finish.cacheRetention, stableKey: request.cache?.key }, route, id)
          evidence.cacheMode = actual.mode
          evidence.ttlSeconds = actual.ttlSeconds
          evidence.retention = actual.control
        }
        evidence.downgradeReason = finish?.cacheDowngradeReason ?? evidence.downgradeReason
        if ((usage?.cacheReadTokens ?? 0) > 0 || (usage?.cacheWriteTokens ?? 0) > 0) evidence.lastCacheEvidenceAt = Date.now()
        if (service !== undefined && start !== undefined) {
          const priced = service.priceUsage({ usage, usageState: usage === undefined ? 'missing' : 'complete',
            tiering: finish?.cacheWriteTiering ?? start.cacheWriteTiering, startedAt, entry: attribution?.price })
          const end: LedgerCallFinish = {
            callId, endedAt: Date.now(), observedAt: Date.now(),
            responseModel: finish?.responseModel, responseModelReported: finish?.responseModelReported ?? 'unobservable',
            effectiveModel: finish?.responseModel ?? request.model, httpStatus: status, usage,
            usageState: usage === undefined ? 'missing' : 'complete', costUsd: priced.costUsd, pricingState: priced.state,
            wallMs: settledAt - clock, modelInFlightMs: admittedAt === undefined ? 0 : settledAt - admittedAt,
            queueMs: (admittedAt ?? settledAt) - clock, backoffMs: 0, waits: [],
            compactionCount: 0, compactionTimes: [], recovered: false,
            endReason: signal.aborted || reason?.kind === 'aborted' ? 'cancelled' : failed ? 'error' : 'completed',
            upstreamStopReason: reason?.kind ?? 'iterator-closed', artifacts,
            accountLabel: finish?.accountLabel, cacheWriteTiering: finish?.cacheWriteTiering, cache: evidence,
            http429Count: status === 429 ? 1 : 0, http503Count: status === 503 ? 1 : 0,
            ...(usage === undefined ? {} : { peakContextTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), peakContextSource: 'usage' as const }),
          }
          committed(await service.finishCall(end))
          await fact(service, start, { kind: 'cache/evidence', evidence })
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
      if (type === 'llm/retry-started') state.attemptIndex += 1
      queueFact(state, { kind: 'retry', phase: type === 'llm/retry' ? 'scheduled' : 'started', logicalRequestId: state.logicalRequestId, attemptIndex: state.attemptIndex })
    }
    if (type === 'compaction/summary' || type === 'image/offload' || type === 'message/prune') state.reasons.add(type)
    if (event.surfaceOp?.op === 'replace') state.reasons.add('history-edit')
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
