/** Explicitly installed engine provider; absent optional services never alter upstream behavior. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-agent'
import type { CacheRenewOperationId } from '@panedesk/dsh-llm-cache'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type { SeatEngineConfig } from '@panedesk/dsh-seat'
import { SeatEngine } from './engine.ts'
import { EngineError } from './journal.ts'
import { CompletionProviders } from './notifications.ts'
import { ChildAdmissionProvider } from './child-admission.ts'
import { registerProductionSources, type ProductionSource } from './production-sources.ts'

export { SeatEngine } from './engine.ts'
export type { EngineOptions, EngineDependencies } from './engine.ts'
export { EngineJournal, EngineError, frame, digest } from './journal.ts'
/** Loader plugin identity. */
export const name = 'seat-engine'
/** Optional dependencies are resolved through the service store. */
export const inject: string[] = []
/** Deployment policy has no implicit budget or capacity defaults. */
export interface Config extends SeatEngineConfig {
  /** Harness home containing the node journal; omitted uses the standard home resolver. */
  home?: string
  /** Explicit trusted trigger observers; omitted leaves only separately registered manual and external ingress. */
  sources?: readonly ProductionSource[]
}
/** Validate deployment policy before acquiring a writer or accepting ingress.
 * @param config - explicit deployment values.
 * @returns the validated configuration.
 */
export function validateConfig(config: Config): Config {
  for (const key of ['dedupWindowMs', 'maxDecisionBytes', 'maxSourceBytes', 'maxBatchSeats', 'maxCauseDepth',
    'callbackTimeoutMs', 'callbackMaxResponseBytes', 'callbackRetryInitialMs', 'callbackRetryMaxMs',
    'ownerObserveIntervalMs', 'ownerReleaseBudgetMs', 'queueWakeBudgetMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new EngineError('invalid-request', `Invalid engine setting: ${key}`)
  }
  if (!config.nodeName || config.ownerObserveIntervalMs > 1000
    || config.ownerReleaseBudgetMs + config.queueWakeBudgetMs + config.ownerObserveIntervalMs > 5000
    || config.callbackRetryMaxMs < config.callbackRetryInitialMs
    || (config.nodeEngineWindowLimit !== undefined
      && (!Number.isSafeInteger(config.nodeEngineWindowLimit) || config.nodeEngineWindowLimit < 1))) {
    throw new EngineError('invalid-request', 'Invalid engine capacity or timing policy')
  }
  new Intl.DateTimeFormat('en-US', { timeZone: config.budgetTimeZone }).format()
  const identities = new Set<string>()
  for (const source of config.sources ?? []) {
    if (!source.sourceId || identities.has(source.sourceId) || !source.seat || !source.projectId) {
      throw new EngineError('invalid-request', 'Invalid or duplicate production source identity')
    }
    identities.add(source.sourceId)
    const trigger = source.trigger
    if (trigger.kind === 'git' && (!trigger.repository || !trigger.repositoryId || !trigger.ref.startsWith('refs/')
      || !Number.isSafeInteger(trigger.fallbackMs) || trigger.fallbackMs < 1)) {
      throw new EngineError('invalid-request', 'Invalid Git source configuration')
    }
    if (trigger.kind === 'handoff-timeout' && (!Number.isFinite(trigger.timeoutMinutes) || trigger.timeoutMinutes <= 0)) {
      throw new EngineError('invalid-request', 'Invalid handoff timeout')
    }
    if (trigger.kind === 'window-ended' && source.seat === trigger.seat) {
      throw new EngineError('invalid-request', 'Window-ended source cannot target itself')
    }
  }
  return config
}
/** Install only while the reference ledger is available; its node identity remains authoritative.
 * @param ctx - plugin owner.
 * @param config - explicit node policy and optional isolated home.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  ctx.on('agent/turn-admitting', async ({ agent }, next) => {
    const upstream = await next()
    if (upstream.kind !== 'allow') return upstream
    const engine = ctx.get('seatEngine')
    if (!engine) return upstream
    const admission = await engine.admitTurn(agent.id)
    return admission.status === 'allow' ? upstream : { kind: 'defer', reason: admission.reason }
  })
  ctx.inject(['sessionLedger'], (child) => {
    const ledger = child.get('sessionLedger')
    if (!ledger) return
    child.effect(() => {
      let engine: SeatEngine | undefined, stopped = false
      let completions: CompletionProviders | undefined, admission: ChildAdmissionProvider | undefined
      let stopSources: (() => Promise<void>) | undefined
      const starting = ledger.nodeId().then(async (nodeId) => {
        if (stopped) return
        engine = new SeatEngine(child, { home: resolveDshHome(config.home), nodeId: nodeId, config },
          { seats: () => child.get('seats'), ledger: () => child.get('sessionLedger'), keepalive: {
            remaining: async (sessionId) => {
              const agent = child.get('agents')?.get(sessionId), cache = child.get('llmCache')
              return agent && cache ? cache.remaining(agent) : { kind: 'unknown' }
            },
            renew: async (sessionId, operationId) => child.get('llmCache')?.renewOnce({ sessionId,
              operationId: operationId as string as CacheRenewOperationId })
              ?? { kind: 'rejected', reason: 'cache-evidence-unavailable' },
          } })
        await engine.ready()
        completions = new CompletionProviders(child, engine)
        admission = new ChildAdmissionProvider(child, engine)
        child.provide('subagentAdmission', admission)
        child.provide('subagentNotifications', completions.subagents)
        child.provide('jobNotifications', completions.jobs)
        await admission.start()
        completions.start()
        stopSources = registerProductionSources(child, engine, config.sources ?? [])
      })
      void starting.catch(() => { console.error('Seat engine startup failed; ingress is unavailable') })
      return async () => {
        stopped = true
        try { await starting } finally {
          try { await stopSources?.() } finally {
            try { await admission?.close() } finally {
              try { await completions?.close() } finally { await engine?.shutdown() }
            }
          }
        }
      }
    })
  })
}
