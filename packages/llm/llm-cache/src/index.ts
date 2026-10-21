/** Cache plugin scaffold; no middleware, settings, timers, or model requests are registered yet. */
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { CachePolicy, FamilyConcurrencyLimit, KeepalivePolicy } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'llm-cache'
/** Reserved dependencies; the scaffold does not activate services. */
export const inject: string[] = []
/** Session cache and harness-process concurrency configuration. */
export interface Config {
  /** Session retention and stable cache-key selection. */
  policy: CachePolicy
  /** Explicit opt-in maintenance scheduling and output budget. */
  keepalive: KeepalivePolicy
  /** Shared in-flight caps per model family within this harness process. */
  concurrency: FamilyConcurrencyLimit[]
}
/** Configuration defaults never enable keepalive implicitly. */
export const Config = z.object({
  policy: z.object({
    retention: z.union(['default', 'none', '5m', '1h', '30m', '12h', 'auto']).default('default'),
    stableKey: z.string(),
  }),
  keepalive: z.object({
    enabled: z.boolean().default(false),
    leadSeconds: z.number().min(1).default(240),
    minimumIntervalSeconds: z.number().min(1).default(60),
    maxOutputTokens: z.number().min(1).default(1),
  }),
  concurrency: z.array(z.object({
    modelFamily: z.string().required(),
    maxInFlight: z.number().min(1).required(),
  })).default([]),
})
/** Placeholder only; installing this scaffold changes no runtime behavior.
 * @param ctx - plugin-owned context reserved for later reversible registrations.
 * @param config - validated deployment settings reserved for the implementation.
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
