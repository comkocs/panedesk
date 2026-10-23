/** Production adapters use installed public services; missing evidence is never interpreted as idle. */
import type { Context } from '@panedesk/cordis'
import { foldConsumedWork } from '@panedesk/dsh-agent'
import type { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type { CacheRenewOperationId } from '@panedesk/dsh-llm-cache'
import type {} from '@panedesk/dsh-session-title'
import type {} from '@panedesk/dsh-workspace'
import type {} from '@panedesk/dsh-user-questions'
import type {} from '@panedesk/dsh-jobs'
import type {} from '@panedesk/dsh-permission-presets'
import type * as T from '@panedesk/dsh-seat'
import type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
import { rejected } from './errors.ts'
import { digest } from './store.ts'
import { createWaitObservation } from './wait-observation.ts'
import { LocalEngineState } from './engine-state.ts'
import { projectedWaits } from './wait-store.ts'
import { LocalRenamer } from './rename.ts'
import type {} from '@panedesk/dsh-session-query'

/** Build late-bound public adapters without instantiating upstream private controllers.
 * @param ctx - plugin-owned context.
 * @param options - validated deployment limits.
 * @returns local capabilities shared by the service and registered executor.
 */
export function createLocalRuntime(ctx: Context, options: LocalSeatOptions): LocalSeatRuntime {
  const state = new LocalEngineState(() => ctx.get('seatEngine'), options.nodeId, options.pageSize, options.transactionRetries)
  const observation = createWaitObservation(ctx, state)
  const renamer = new LocalRenamer(ctx)
  ctx.effect(() => () => renamer.close())
  const cache = async (sessionId: SessionId): Promise<T.SeatCacheEvidence> => {
    const ledger = await ctx.get('sessionLedger')?.query({ sessionId })
    const calls = ledger?.rows.filter(row => row.kind === 'call') ?? []
    const last = calls.at(-1)
    const evidence = last?.finish?.cache ?? last?.start.cache
    return { lastActivityAt: evidence?.lastCacheEvidenceAt === undefined ? null : new Date(evidence.lastCacheEvidenceAt).toISOString(),
      cacheTtlMs: evidence?.ttlSeconds === undefined ? null : evidence.ttlSeconds * 1000,
      prefixDigest: evidence?.prefixFingerprint === undefined ? null : evidence.prefixFingerprint as T.SeatDigest,
      observedAt: new Date().toISOString(), reusableRequest: ledger?.complete === true && evidence?.prefixFingerprint !== undefined }
  }
  return { context: ctx, catalogs: { nodeId: options.nodeId, nodeAliases: options.nodeAliases, defaults: options.defaults,
    validateOptions: (definition) => {
      const presets = ctx.get('permissionPresets')
      if (presets !== undefined && !presets.names.includes(definition.permissionPreset)) {
        return Promise.resolve(rejected('invalid-definition', 'Permission preset is not installed.', 'Select an installed permission preset.'))
      }
      return Promise.resolve(null)
    } },
  cache,
  evidence: async (sessionId) => {
    const agent = ctx.get('agents')?.get(sessionId)
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    const questions = agent === undefined ? undefined : ctx.get('userQuestions')?.pendingForSession(agent.session)
    const snapshot = await ctx.get('sessionQuery')?.readSession(sessionId)
    const events = snapshot?.events ?? []
    const consumed = foldConsumedWork(events)
    const last = events.at(-1)
    const approvals = new Set<string>()
    for (const event of events) {
      if (event.type === 'approval/asked') approvals.add(event.data.id)
      if (event.type === 'approval/decided') approvals.delete(event.data.id)
    }
    const engine = ctx.get('seatEngine')
    const facts = engine === undefined ? null : (await state.read()).effects
    const waits = facts === null ? [] : [...projectedWaits(facts).values()]
      .filter(wait => wait.sessionId === sessionId && (wait.phase === 'registered' || wait.phase === 'satisfied')).map(wait => wait.waitId)
    const tickets = new Map<string, T.ChildAdmissionTicket>()
    for (const effect of facts ?? []) {
      if (effect.kind === 'child/queued' || effect.kind === 'child/admitted') tickets.set(effect.data.ticketId, effect.data)
      if (effect.kind === 'child/released') tickets.delete(effect.data.ticketId)
    }
    const jobs = ctx.get('jobs')?.list(sessionId).filter(job => job.owner === sessionId && job.status === 'running').map(job => job.id) ?? []
    const subagents = activity.filter(item => item.kind === 'subagent').flatMap(item => item.items?.map(child => child.id) ?? [item.kind])
    const pendingQuestions = [...questions?.blocking.flatMap(item => item.questions) ?? [],
      ...questions?.timed.flatMap(item => item.questions) ?? []]
    return { complete: agent !== undefined && snapshot !== undefined && facts !== null
        && questions?.available === true && ctx.get('jobs') !== undefined,
    running: agent?.status === 'running', approvals: [...approvals],
    planReviews: pendingQuestions.filter(item => item.intent?.kind === 'plan-review').map((_, index) => `plan:${index}`),
    answers: pendingQuestions.filter(item => item.intent?.kind !== 'plan-review').map((_, index) => `answer:${index}`), subagents, jobs,
    waits, tickets: [...tickets.values()].filter(ticket => ticket.parentSessionId === sessionId).map(ticket => ticket.ticketId),
    inbox: agent === undefined ? [] : [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id),
    lastConsumedTurn: consumed.end === undefined ? null : consumed.end.data.reason.kind === 'completed' ? 'completed' : 'other',
    droppedUnrun: consumed.droppedUnrun, lastActivityAt: last === undefined ? null
      : new Date(last.time).toISOString(), stateVersion: events.length }
  },
  renew: async (request) => {
    const cacheEvidence = await cache(request.sessionId)
    const result = await ctx.get('llmCache')?.renewOnce({ sessionId: request.sessionId,
      operationId: String(request.operationId) as CacheRenewOperationId })
    if (result?.kind === 'renewed') return { status: 'renewed', sessionId: request.sessionId, cacheEvidence: await cache(request.sessionId) }
    if (result?.kind === 'uncertain') return { status: 'uncertain', cacheEvidence,
      error: rejected('renewal-uncertain', 'Maintenance outcome is uncertain.', 'Do not replay this maintenance attempt.').error }
    return { ...rejected('cache-evidence-unavailable', 'Cache maintenance is unavailable.', 'Wait for reusable cache evidence.'), cacheEvidence }
  },
  rename: request => renamer.rename(request),
  title: async (sessionId) => {
    const agent = ctx.get('agents')?.get(sessionId)
    return (agent === undefined ? (await ctx.get('sessionQuery')?.readTitle(sessionId))?.title
      : ctx.get('sessionTitle')?.get(agent.session)?.title) ?? null
  },
  send: async (request) => {
    const delivery = ctx.get('messageDelivery')
    if (delivery === undefined) throw new Error('Message delivery is unavailable')
    const result = await delivery.send({ target: { sessionId: request.sessionId }, content: request.text,
      operationId: digest(request.operationId) as string as OperationId, messageClass: 'handoff', priority: request.mode })
    if (result.deliveryOutcome !== 'accepted' && result.reason !== 'target-closed-pending') throw new Error(`Message delivery refused: ${result.reason}`)
    return { messageId: result.messageId }
  }, ...observation }
}
