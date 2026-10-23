/** Optional startup reconciliation and independently owned continuous watching. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-cmdline'
import type { LedgerNodeId } from '@panedesk/dsh-session-ledger'
import { writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import z from '@panedesk/schemastery'
import { reconcileRuns, startWatching } from './watch.ts'
import type { ReconcileReport } from './watch.ts'
import type { LedgerWatchOptions, LedgerOwnerSettled } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'ledger-watch'
/** Missing ledger leaves ordinary harness behavior unchanged. */
export const inject: string[] = []
/** Watcher deployment settings. */
export interface Config extends LedgerWatchOptions {}
/** Explicit node ownership and opt-in polling prevent scans of imported remote nodes. */
export const Config = z.object({
  intervalMs: z.number().min(1).default(2000),
  settlementBudgetMs: z.number().min(1).max(10000).default(10000),
  scanOnStart: z.boolean().default(true),
  nodeId: z.string(),
  continuous: z.boolean(),
  healthPath: z.string(),
})
/** Attach a reversible startup scan or non-overlapping polling loop.
 * @param ctx - context with an optional public ledger service.
 * @param config - validated local-node and timing policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['sessionLedger'], (child) => { attachWatcher(child, config) })
}

function attachWatcher(ctx: Context, config: Config): void {
  const ledger = ctx.get('sessionLedger')
  if (!ledger || !config.nodeId) return
  const appExit = ctx.get('appExit')
  const onError = (error: unknown) => {
    void error
    console.error('Ledger watcher failed; reconciliation stopped and health was not refreshed')
    appExit?.(1)
  }
  const onRound = async (report: ReconcileReport) => {
    if (!config.healthPath) return
    const path = `${config.healthPath}.${randomUUID()}`
    await writeFile(path, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(path, config.healthPath)
  }
  const options = { nodeId: config.nodeId as LedgerNodeId, intervalMs: config.intervalMs, settlementBudgetMs: config.settlementBudgetMs,
    onAlert: (code: string) => { console.error(`Ledger watcher alert: ${code}`) },
    onOwnerSettled: (payload: LedgerOwnerSettled) => {
      const args: unknown[] = ['ledger-watch/owner-settled', payload]
      for (const callback of ctx.events.dispatch('emit', args)) {
        try {
          const returned: unknown = callback(...args)
          void Promise.resolve(returned).catch(() => { ctx.logger.warn('Ledger owner settlement listener rejected') })
        } catch (_error) {
          ctx.logger.warn('Ledger owner settlement listener threw')
        }
      }
    } }
  let stopped = false, running: Promise<unknown> = Promise.resolve(), stop: (() => Promise<void>) | undefined
  const start = () => {
    if (stopped) return
    if (config.continuous) {
      const controller = startWatching(ledger, { ...options, scanOnStart: config.scanOnStart, onRound, onError })
      running = controller.settled
      stop = () => controller.stop()
    } else if (config.scanOnStart) {
      running = reconcileRuns(ledger, options).then(onRound)
      void running.catch(onError)
    }
  }
  ctx.effect(() => {
    const ready = ctx.get('appReady')
    const remove = ready ? ready.onReady(start) : undefined
    if (!ready) start()
    return async () => {
      stopped = true; remove?.()
      if (stop) await stop()
      else await running
    }
  })
}
