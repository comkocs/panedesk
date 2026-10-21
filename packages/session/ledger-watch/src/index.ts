/** Independent watcher scaffold; no scans, timers, or process operations are started. */
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { LedgerWatchOptions } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'ledger-watch'
/** The scaffold registers no service consumers. */
export const inject: string[] = []
/** Watcher deployment settings; the implementation verifies process creation identities. */
export interface Config extends LedgerWatchOptions {}
/** Scan interval and total settlement budget in milliseconds. */
export const Config = z.object({
  intervalMs: z.number().min(1).default(2000),
  settlementBudgetMs: z.number().min(1).default(10000),
  scanOnStart: z.boolean().default(true),
})
/** Placeholder only; no processes are inspected or signalled.
 * @param ctx - plugin context reserved for later reversible registrations.
 * @param config - validated watcher settings.
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
