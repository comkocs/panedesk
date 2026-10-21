/** Ledger checkpoint plugin scaffold; no compaction hooks are registered yet. */
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { CompactionLedgerOptions } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'compaction-ledger'
/** The scaffold registers no service consumers. */
export const inject: string[] = []
/** Bounded checkpoint projection settings. */
export interface Config extends CompactionLedgerOptions {}
/** Runtime data budget and bounded snapshot retries. */
export const Config = z.object({
  recentEventLimit: z.number().min(0).default(10),
  maxTokens: z.number().min(1).default(1024),
  snapshotRetries: z.number().min(0).default(2),
})
/** Placeholder only; summaries and checkpoints remain unchanged.
 * @param ctx - plugin context reserved for later reversible registrations.
 * @param config - validated checkpoint limits.
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
