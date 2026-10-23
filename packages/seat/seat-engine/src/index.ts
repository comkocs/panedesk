/** Explicitly installed engine provider; absent optional services never alter upstream behavior. */
import type { Context } from '@panedesk/cordis'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type { SeatEngineConfig } from '@panedesk/dsh-seat'
import { SeatEngine } from './engine.ts'
import { EngineError } from './journal.ts'

export { SeatEngine } from './engine.ts'
export type { EngineOptions, EngineDependencies } from './engine.ts'
export { EngineJournal, EngineError, frame, digest } from './journal.ts'
/** Loader plugin identity. */
export const name = 'seat-engine'
/** Optional dependencies are resolved through the service store. */
export const inject: string[] = []
/** Deployment policy has no implicit budget or capacity defaults. */
export interface Config extends SeatEngineConfig { home?: string }
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
  return config
}
/** Install only while the reference ledger is available; its node identity remains authoritative.
 * @param ctx - plugin owner.
 * @param config - explicit node policy and optional isolated home.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  ctx.inject(['sessionLedger'], (child) => {
    const ledger = child.get('sessionLedger')
    if (!ledger) return
    child.effect(() => {
      let engine: SeatEngine | undefined, stopped = false
      const starting = ledger.nodeId().then(async (nodeId) => {
        if (stopped) return
        engine = new SeatEngine(child, { home: resolveDshHome(config.home), nodeId: nodeId, config },
          { seats: () => child.get('seats'), ledger: () => child.get('sessionLedger') })
        await engine.ready()
      })
      void starting.catch(() => { console.error('Seat engine startup failed; ingress is unavailable') })
      return async () => { stopped = true; try { await starting } finally { await engine?.shutdown() } }
    })
  })
}
