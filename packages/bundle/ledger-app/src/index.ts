/** Offline ledger application scaffold; no command execution or profile registration occurs. */
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { LedgerAppOptions } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'ledger-app'
/** The scaffold registers no service consumers. */
export const inject: string[] = []
/** Offline application mode. */
export interface Config extends LedgerAppOptions {}
/** Query is the non-watching default. */
export const Config = z.object({
  mode: z.union(['query', 'watch']).default('query'),
})
/** Placeholder only; no Agent, LLM, command, or process is started.
 * @param ctx - plugin context reserved for later reversible registrations.
 * @param config - validated application mode.
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
