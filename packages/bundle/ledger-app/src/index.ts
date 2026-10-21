/** Minimal offline app: command execution begins only after launcher readiness. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-cmdline'
import type {} from '@panedesk/dsh-ledger-query'
import * as watcher from '@panedesk/dsh-ledger-watch'
import z from '@panedesk/schemastery'
import type { LedgerAppOptions } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'ledger-app'
/** Offline operation requires launcher facts, never an Agent, LLM, or credentials. */
export const inject = ['cmdlineArgs', 'appReady', 'appExit']
/** Offline application mode. */
export interface Config extends LedgerAppOptions {}
/** Query exits after one operation; watch requires explicit node ownership. */
export const Config = z.object({ mode: z.union(['query', 'watch']).default('query'), nodeId: z.string(), healthPath: z.string() })
/** Register ready-gated execution and retain pending work during teardown.
 * @param ctx - launcher context with optional query provider.
 * @param config - validated query/watch selection.
 */
export function apply(ctx: Context, config: Config): void {
  const args = ctx.get('cmdlineArgs'), ready = ctx.get('appReady'), exit = ctx.get('appExit')
  if (!args || !ready || !exit) throw new Error('Ledger app requires launcher arguments, readiness and exit services')
  if (config.mode === 'watch') {
    if (!config.nodeId) throw new Error('Ledger watch mode requires a local node')
    if (args.get().length) throw new Error('Ledger watch mode accepts configuration, not command arguments')
    ctx.plugin(watcher, { intervalMs: 2000, settlementBudgetMs: 10000, scanOnStart: true,
      continuous: true, nodeId: config.nodeId, healthPath: config.healthPath })
    return
  }
  let running: Promise<void> = Promise.resolve()
  ctx.effect(() => {
    const remove = ready.onReady(() => {
      running = (async () => {
        try {
          const service = ctx.get('ledgerQuery')
          if (!service) throw new Error('Ledger query provider is unavailable')
          const result = await service.execute(args.get())
          process.stdout.write(JSON.stringify(result.output) + '\n')
          exit(result.code)
        } catch (error) {
          void error
          console.error('Ledger command failed; check arguments, input integrity and output permissions')
          exit(1)
        }
      })()
    })
    return async () => { remove(); await running }
  })
}
