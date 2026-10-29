/** Instance-owned model-call accounting; optional contributors never write call lifecycle facts. */
import { ledgerUuid as randomUUID } from './random.ts'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { LlmAdapter, LlmError } from '@panedesk/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage, ToolCallId } from '@panedesk/dsh-llm'
import type { SessionLedger } from './index.ts'
import type {
  LedgerCallId, LedgerRequestId, LedgerEventId, LedgerCallStart, LedgerCallFinish,
  LedgerCacheEvidence, LedgerArtifactReference, LedgerAuxiliaryFact,
} from './types.ts'
import type { CallContributor, CallContribution, CallContributionScope } from './call-contributor.ts'
import { callWaits } from './call-waits.ts'

interface SessionState {
  logicalRequestId: LedgerRequestId
  attemptIndex: number
  retryPending: boolean
  pending: Promise<void>
  failure?: unknown
  lastStart?: LedgerCallStart
  stopped: boolean
  backoffMs: number
  backoffStarted?: number | undefined
  compactionTimes: number[]
  active: Set<Promise<void>>
  partial?: LedgerArtifactReference | undefined
}

function committed(result: { kind: string }): void {
  if (result.kind === 'conflict') throw new Error('Ledger rejected conflicting call evidence')
}

/** Install one stream owner and return its instance-local contribution registrar.
 * @param ctx - Ledger-owned effect scope.
 * @param service - Durable call provider.
 * @param hasCompactionOwner - Instance-owned registration state, independent of event delivery order.
 * @param readWaits - Provider-owned keyed lookup; absent providers retain snapshot semantics.
 * @returns Registrar rejecting concurrent owners and returning an idempotent disposer.
 */
export function installCallAccounting(ctx: Context, service: SessionLedger,
  hasCompactionOwner: () => boolean,
  readWaits: (start: LedgerCallStart, ids: readonly ToolCallId[]) => Promise<import('./types.ts').LedgerInterval[]>
    = async (start, ids) => callWaits(await service.snapshot({ sessionId: start.sessionId }), start, ids),
): (contributor: CallContributor) => () => void {
  const states = new Map<string, SessionState>()
  const lifetime = new AbortController()
  const operations = new Set<Promise<void>>()
  let contributor: CallContributor | undefined

  function stateOf(id: string): SessionState {
    let state = states.get(id)
    if (state !== undefined) return state
    state = { logicalRequestId: randomUUID() as LedgerRequestId, attemptIndex: 0, retryPending: false,
      pending: Promise.resolve(), stopped: false, backoffMs: 0, compactionTimes: [], active: new Set() }
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
    const start = state.lastStart
    if (start === undefined) return
    state.pending = state.pending.then(() => fact(service, start, value)).catch((error: unknown) => {
      state.failure = error
      ctx.logger.warn('Cache ledger observation failed; further calls are blocked')
    })
  }

  ctx.on('agent/created', async ({ agent }) => {
    const state = stateOf(agent.id)
    const snapshot = await service.snapshot({ sessionId: agent.id })
    state.compactionTimes = snapshot.rows.flatMap(row => row.kind === 'event' && row.event.kind === 'compaction' ? [row.event.committedAt] : [])
    for (const row of snapshot.rows) {
      if (row.kind === 'call' && row.start.purpose === 'conversation'
        && (state.lastStart === undefined || row.start.startedAt >= state.lastStart.startedAt)) state.lastStart = row.start
    }
  })
  ctx.on('agent/ending', async ({ agent }) => {
    const state = states.get(agent.id)
    if (state === undefined) return
    state.stopped = true
    await Promise.all([...state.active])
    await state.pending
    if (state.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: state.failure })
  })
  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.id) })

  ctx.on('llm/stream', (request, next) => stream(request, next), { prepend: true })

  async function* stream(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const agent = request.sessionId === undefined ? ctx.get('agents')?.currentInitiator() : ctx.get('agents')?.get(request.sessionId)
    const id = request.sessionId ?? agent?.id ?? `auxiliary:${randomUUID()}`
    const sessionState = stateOf(id)
    const auxiliary = request.purpose !== undefined && request.purpose !== 'keepalive'
    const state = auxiliary ? stateOf(`call:${randomUUID()}`) : sessionState
    const completed = Promise.withResolvers<void>()
    operations.add(completed.promise)
    sessionState.active.add(completed.promise)
    let contribution: CallContribution | undefined
    try {
      await sessionState.pending
      if (sessionState.stopped || lifetime.signal.aborted) throw new Error('Cache accounting is closing')
      if (sessionState.failure !== undefined) throw new Error('Cache accounting requires repair', { cause: sessionState.failure })
      contribution = await contributor?.prepare({ request, id, agent, auxiliary })
      yield* metered(request, next, id, agent, state, service, contribution)
    } finally {
      try { await contribution?.dispose(state.failure) } finally {
        completed.resolve()
        operations.delete(completed.promise)
        sessionState.active.delete(completed.promise)
        if (state.failure !== undefined) sessionState.failure = state.failure
        if (auxiliary) for (const [key, value] of states) { if (value === state) states.delete(key) }
      }
    }
  }

  async function* metered(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>, id: string,
    agent: Agent | undefined, state: SessionState, service: SessionLedger,
    contribution: CallContribution | undefined): AsyncGenerator<StreamChunk> {
    const callId = randomUUID() as LedgerCallId
    const evidence: LedgerCacheEvidence = contribution?.evidence ?? { cacheMode: 'unknown', breakReasons: [] }
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
      provider: request.provider, modelFamily: contribution?.modelFamily ?? request.provider, requestedModel: request.model,
      purpose: request.purpose ?? 'conversation', startedAt, cache: evidence, cacheWriteTiering: { kind: 'unknown' },
      priceVersion: attribution.priceTable?.version ?? attribution.price?.version ?? 'unknown', priceKey: attribution.price?.modelKey ?? 'unknown',
      referencePrice: true,
    }
    const signal = AbortSignal.any([lifetime.signal,
      ...(contribution?.signal === undefined ? [] : [contribution.signal]),
      ...(request.signal === undefined ? [] : [request.signal])])
    committed(await service.beginCall(start))
    if (request.purpose !== 'keepalive') state.lastStart = start
    let release: (() => void) | undefined
    let admittedAt: number | undefined
    let usage: TokenUsage | undefined
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    let partial: LedgerArtifactReference | undefined
    const artifacts: LedgerArtifactReference[] = []
    const toolCallIds = new Set<ToolCallId>()
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
      const scope: CallContributionScope = { start, signal,
        fact: value => fact(service, start, value),
        artifact: async (kind, content, index) => {
          const reference = await artifact(kind, content, index)
          if (reference !== undefined) artifacts.push((await service.finishArtifact(reference)).reference)
        },
      }
      await contribution?.started(scope)
      release = await contribution?.acquire(signal)
      signal.throwIfAborted()
      admittedAt = performance.now()
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.id) toolCallIds.add(chunk.block.id)
        // Persist fragments before exposing them, including requests that later terminate without settlement.
        if (chunk.type !== 'finish' && chunk.type !== 'usage') partial = await artifact('partial-response', JSON.stringify(chunk), seq++)
        yield chunk
      }
    } catch (error: unknown) {
      failure = error
      throw error
    } finally {
      const settledAt = performance.now()
      const endedAt = Date.now()
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
        await contribution?.terminal({ finish, terminalEvidence, usage })
        {
          const entries = attribution.priceTable?.entries ?? (attribution.price === undefined ? [] : [attribution.price])
          const responseMatches = entries.filter(entry => entry.modelKey === finish?.responseModel)
          const requestMatches = entries.filter(entry => entry.modelKey === request.model)
          const responsePrice = responseMatches.length === 1 ? responseMatches[0] : undefined
          const selectedPrice = responsePrice ?? (requestMatches.length === 1 ? requestMatches[0] : undefined)
          let tiering = finish?.cacheWriteTiering ?? start.cacheWriteTiering
          const reportedRetention = terminalEvidence?.reportedCacheRetention
          if (reportedRetention !== undefined && tiering.kind === 'tiered') {
            const known = selectedPrice?.prices.cacheWrite[reportedRetention] !== undefined
              && (reportedRetention === tiering.short || reportedRetention === tiering.long)
            evidence.writePriceTier = known ? reportedRetention : 'unknown'
            if (!known) tiering = { kind: 'unknown' }
          }
          const priced = service.priceUsage({ usage, usageState, tiering, startedAt, entry: selectedPrice })
          const waits = await readWaits(start, [...toolCallIds])
          const timeout = (reason?.kind === 'error' || reason?.kind === 'aborted') && reason.failure.code === 'TIMEOUT'
            || failure instanceof LlmError && failure.code === 'TIMEOUT'
          const cancellation: unknown = request.signal?.aborted ? request.signal.reason : undefined
          const interjection = cancellation !== null && typeof cancellation === 'object'
            && 'kind' in cancellation && cancellation.kind === 'interjection'
          if (interjection) await contribution?.interjected()
          const end: LedgerCallFinish = {
            callId, endedAt, observedAt: Date.now(), toolCallIds: [...toolCallIds],
            ...finish?.responseModel === undefined ? {} : { responseModel: finish.responseModel },
            responseModelReported: finish?.responseModelReported ?? 'unobservable',
            effectiveModel: finish?.responseModel ?? request.model,
            ...status === undefined ? {} : { httpStatus: status }, ...usage === undefined ? {} : { usage },
            usageState,
            ...terminalEvidence?.cacheWriteAccounting === undefined ? {} : { cacheWriteAccounting: terminalEvidence.cacheWriteAccounting },
            ...terminalEvidence?.reportedUsage === undefined ? {} : { reportedUsage: terminalEvidence.reportedUsage },
            ...priced.costUsd === undefined ? {} : { costUsd: priced.costUsd }, pricingState: priced.state,
            priceVersion: start.priceVersion, priceKey: selectedPrice?.modelKey ?? 'unknown',
            priceKeySource: responsePrice !== undefined ? 'response-model' : selectedPrice !== undefined ? 'request-model' : 'unknown',
            wallMs: settledAt - clock, modelInFlightMs: admittedAt === undefined ? 0 : settledAt - admittedAt,
            queueMs: (admittedAt ?? settledAt) - clock, backoffMs: request.purpose === undefined ? state.backoffMs : 0, waits,
            // Session-to-date observations are snapshots, not additional compaction charges.
            compactionCount: state.compactionTimes.length, compactionTimes: [...state.compactionTimes], recovered: false,
            endReason: signal.aborted ? 'cancelled' : timeout ? 'timeout' : reason?.kind === 'aborted' ? 'cancelled' : failed ? 'error' : 'completed',
            ...timeout && !signal.aborted ? { timeoutSource: 'model-call' } : {},
            upstreamStopReason: interjection ? 'interjection' : reason?.kind ?? 'iterator-closed', artifacts,
            ...finish?.accountLabel === undefined ? {} : { accountLabel: finish.accountLabel },
            cacheWriteTiering: tiering, cache: evidence,
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
          await contribution?.settled()
          if (failed) await fact(service, start, { kind: 'alert', alert: { code: admittedAt === undefined ? 'concurrency-rejected' : 'disconnect', message: 'Model call did not complete', redacted: true } })
        }
      } catch (error: unknown) {
        state.failure = error
        ctx.logger.warn('Call settlement failed; further calls are blocked until accounting is repaired')
        if (failure !== undefined) throw new AggregateError([failure, error], 'Model call and ledger settlement failed')
        throw error
      } finally {
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
      if (!hasCompactionOwner()) queueFact(state, { kind: 'compaction', committedSeq: event.seq, committedAt })
    }
    if (event.type === 'assistant/attempt' && state.partial !== undefined) {
      queueFact(state, { kind: 'alert', alert: { code: 'partial-attempt-linked',
        message: `Partial response belongs to assistant attempt at session sequence ${event.seq}`,
        artifact: state.partial.path, redacted: true } })
    }
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
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Ledger accounting disposed'))
    for (const state of states.values()) state.stopped = true
    await Promise.allSettled([...operations])
    await Promise.all([...states.values()].map(state => state.pending))
  })
  return (value) => {
    const dispose = ctx.effect(() => {
      if (contributor !== undefined) throw new Error('Call contributor is already registered')
      contributor = value
      return () => { contributor = undefined }
    })
    return () => { void dispose() }
  }
}
