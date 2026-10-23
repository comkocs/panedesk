/** Opt-in local catalog provider; an absent engine leaves upstream behavior unchanged. */
import type { Context } from '@panedesk/cordis'
import type { LocalSeatOptions } from './service-options.ts'
import { SeatStore } from './store.ts'
import { LocalSeatService } from './service.ts'
import { createLocalRuntime } from './runtime.ts'
import { createOpenExecutor } from './executor.ts'
import { createEngineAccess, registerLocalReadAccess } from './engine-access.ts'
import { LocalSeatDirectoryService } from './directory-service.ts'
import { localFact } from './engine-state.ts'
import { closingState } from './closing-service.ts'
import { localSourceId } from './open-admission.ts'
import type { OwnerEpoch } from '@panedesk/dsh-seat'

export { LocalSeatService } from './service.ts'
export type { LocalSeatOptions, LocalSeatRuntime } from './service-options.ts'
/** Plugin loader identifier. */
export const name = 'seat-local'
/** Storage is required; the engine attaches through an optional child context. */
export const inject = ['storageDomain']
/** Deployment supplies every limit explicitly. */
export interface Config extends LocalSeatOptions {}

/** Validate local configuration without inferring node identity or runtime limits.
 * @param config - deployment configuration.
 * @returns configuration after basic validation.
 */
export function validateConfig(config: Config): Config {
  for (const key of ['maxSourceBytes', 'maxPlans', 'maxOpeningBytes', 'maxBatchSeats', 'pageSize',
    'transactionRetries', 'maxConfirmations'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid seat setting: ${key}`)
  }
  if (!config.directory || !config.nodeId || !config.nodeName || !config.closedSuffix) throw new Error('Seat placement is incomplete')
  return config
}

/** Install services, recovered observers and executors with lifecycle-owned registrations.
 * @param ctx - plugin lifecycle context.
 * @param config - explicit node configuration.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  ctx.effect(() => {
    const lifecycle = new AbortController()
    let service: LocalSeatService | undefined
    let store: SeatStore | undefined
    const starting = (async () => {
      const facility = ctx.get('storageDomain')
      if (facility === undefined) throw new Error('Catalog storage is unavailable')
      store = await SeatStore.open(facility, config.directory)
      if (lifecycle.signal.aborted) return
      const runtime = createLocalRuntime(ctx, config)
      service = new LocalSeatService(ctx, store, config, runtime)
      const installed = service
      registerLocalReadAccess(ctx, installed, config)
      const catalog = store
      ctx.on('agent/turn-admitting', async ({ agent }, next) => {
        const upstream = await next()
        if (upstream.kind !== 'allow' || ctx.get('seatEngine') === undefined) return upstream
        const closing = closingState((await installed.state.read()).effects, agent.id)
        return closing && !closing.barrierReleased ? { kind: 'defer', reason: 'Window close is pending.' } : upstream
      })
      ctx.inject(['seatEngine', 'fs', 'sandboxPolicy', 'agents'], (child) => {
        new LocalSeatDirectoryService(child, installed.state, () => catalog.snapshot().definitions)
      })
      ctx.inject(['seatEngine'], (child) => {
        child.effect(() => {
          const engine = child.get('seatEngine')
          if (engine === undefined) throw new Error('Injected seat engine is unavailable')
          const unregisterSource = engine.registerSource({ sourceId: localSourceId, kinds: ['manual'], maxRedeliveryMs: null,
            callback: () => Promise.resolve() })
          const unregister = engine.registerExecutor(createOpenExecutor(child, runtime, config))
          const unregisterAccess = engine.registerLocalAccess?.(createEngineAccess(installed, config))
          const recovery = engine.ready().then(() => installed.recover())
          void recovery.catch((error: unknown) => { child.logger.warn('Seat recovery failed', error) })
          return async () => {
            try { await unregister(); await unregisterAccess?.(); await unregisterSource(); await recovery }
            finally { await installed.pause() }
          }
        })
        child.effect(() => {
          const pending = new Set<import('@panedesk/dsh-session').SessionId>()
          const observing = new AbortController()
          let running = Promise.resolve()
          const schedule = (sessionId: import('@panedesk/dsh-session').SessionId) => {
            if (observing.signal.aborted || pending.has(sessionId)) return
            pending.add(sessionId)
            running = running.then(async () => {
              pending.delete(sessionId)
              if (!observing.signal.aborted) await installed.reevaluateReport(sessionId)
            }).catch((error: unknown) => { child.logger.warn('Seat report evaluation failed', error) })
          }
          const offStatus = child.on('agent/status', ({ agent, status }) => {
            if (status === 'idle') schedule(agent.id)
          })
          const offEvent = child.on('session/event', (session, event) => {
            if (event.type === 'job/settled' || event.type === 'approval/decided' || event.type === 'step/end') schedule(session.id)
          })
          const offDecision = child.on('seat/decision', (decision) => {
            for (const effect of decision.effects) {
              if (effect.kind === 'open/configured' && effect.data.completedStages.includes('opening')) {
                child.get('agents')?.get(effect.data.sessionId)?.wake?.()
              }
              if (effect.kind === 'wait/woken' || effect.kind === 'wait/cancelled') schedule(effect.data.sessionId)
              if (effect.kind === 'child/released') schedule(effect.data.parentSessionId)
              if (effect.kind === 'job/observed' && effect.data.phase === 'settled') schedule(effect.data.sessionId)
            }
          })
          return async () => { observing.abort(); offStatus(); offEvent(); offDecision(); await running }
        })
        child.on('subagent/before-start', async ({ parent, info }) => {
          await installed.state.mutate((effects) => {
            const exists = effects.some(effect => effect.kind === 'job/observed'
              && effect.data.observation.object.kind === 'subagent' && effect.data.observation.object.id === info.runId)
            return { result: undefined, effects: exists ? [] : [localFact({ kind: 'job/observed', sessionId: parent.id,
              data: { sessionId: parent.id, ownerEpoch: String(info.runId) as OwnerEpoch, phase: 'running', observation: {
                object: { kind: 'subagent', id: info.runId }, outcome: 'unknown', watermark: 1,
                observedAt: new Date().toISOString(), durability: 'durable' } } })] }
          })
        })
        child.on('subagent/after-settle', async ({ parent, info }) => {
          await installed.state.mutate((effects) => {
            const exists = effects.some(effect => effect.kind === 'job/observed' && effect.data.phase === 'settled'
              && effect.data.observation.object.kind === 'subagent' && effect.data.observation.object.id === info.runId)
            return { result: undefined, effects: exists ? [] : [localFact({ kind: 'job/observed', sessionId: parent.id,
              data: { sessionId: parent.id, ownerEpoch: String(info.runId) as OwnerEpoch, phase: 'settled', observation: {
                object: { kind: 'subagent', id: info.runId }, watermark: 2, observedAt: new Date().toISOString(), durability: 'durable',
                outcome: info.stopReason === 'completed' ? 'completed' : info.stopReason === 'aborted' ? 'cancelled' : 'failed' } } })] }
          })
        })
      })
    })()
    void starting.catch((error: unknown) => { ctx.logger.warn('Seat provider startup failed', error) })
    return async () => {
      lifecycle.abort()
      try { await starting } finally { await service?.stop(); await store?.close() }
    }
  })
}
