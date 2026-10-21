/** Session cache policy and process-local model-family admission settings. */
import type { CacheRetention, LlmCacheControl } from '@panedesk/dsh-llm'

/** Session-scoped retention selection; omitted requests resolve through the explicit default policy. */
export interface CachePolicy {
  /** Provider-validated retention; default selects the shortest supported tier of at least one hour. */
  retention: CacheRetention
  /** Session-stable attribution key; omission delegates key selection to the session policy. */
  stableKey?: string
}
/** Opt-in maintenance; unknown or automatic TTL never schedules a speculative keepalive. */
export interface KeepalivePolicy {
  /** Maintenance is disabled unless explicitly enabled. */
  enabled: boolean
  /** Seconds before estimated expiry at which an idle session may refresh evidence. */
  leadSeconds: number
  /** Lower bound between maintenance requests, including short retention tiers. */
  minimumIntervalSeconds: number
  /** Positive output-token cap for each maintenance request. */
  maxOutputTokens: number
}
/** One harness-process limit shared by routes in the same model family. */
export interface FamilyConcurrencyLimit {
  /** Family key shared across provider routes in this process. */
  modelFamily: string
  /** Positive count of simultaneous physical requests, including auxiliary calls. */
  maxInFlight: number
}
/** Effective adapter controls plus evidence for an explicit policy downgrade. */
export interface ResolvedCachePolicy {
  control: LlmCacheControl
  mode: 'disabled' | 'explicit' | 'automatic' | 'unknown'
  ttlSeconds?: number
  downgradeReason?: string
}
/** Cache remaining time is estimated from observed reads/writes, not merely a dispatched request. */
export type CacheRemaining =
  | { kind: 'estimated'; seconds: number; evidenceAt: number; ttlSeconds: number }
  | { kind: 'automatic' | 'disabled' | 'unknown' }
